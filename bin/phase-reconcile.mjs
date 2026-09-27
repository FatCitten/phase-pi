#!/usr/bin/env node
/**
 * phase-reconcile — evidence-based, audited reconciliation of a ticket store
 * against repository reality.
 *
 * Unlike the demo worker (which blindly runs whatever a ticket says to do),
 * reconcile decides from EVIDENCE whether an OPEN ticket is actually already
 * done. It never fabricates completion: a ticket is only marked done when a
 * configured/auto-derived verification passes (e.g. a git commit exists whose
 * message matches the objective). Everything else is reported as unverified
 * and left OPEN.
 *
 * Safety model:
 *   - DRY-RUN BY DEFAULT: prints the reconciliation plan, changes nothing.
 *   - `--apply` is required to mutate the store.
 *   - Every mutation is written as an audit event on the CONTROL bus
 *     (`ticket.reconcile`) plus a `done` transition, so the change is fully
 *     attributable (who/which commit/what evidence).
 *   - No shell injection: commands are run via execFile with arg arrays.
 *   - Path containment: ticket dir / repo are canonicalized; we never write
 *     outside the ticket store. Malformed tickets are reported, not written.
 *   - Reverse drift (a done ticket whose evidence vanished) is REPORTED only,
 *     never auto-reverted.
 *
 * Usage:
 *   phase-reconcile [--repo R] [--home H] [--apply] [--all]
 *                   [--ticket T-... [--ticket T-...]]
 *                   [--map T-ABYSS-S2="Task 003"]          (explicit git keyword)
 *                   [--verbose]
 *
 * Evidence model per ticket:
 *   1. If --map gives a git keyword for the ticket -> git-repo commit-grep.
 *   2. Else auto-derive: the first 3 significant words of the objective.
 *   3. A ticket is RECONCILABLE only when a matching commit is found.
 *   4. Gated tickets (meta.gating === true) additionally require ALL their
 *      dependencies to be done before they may be marked done.
 */
import { TicketStore } from '../src/bus.mjs';
import { objectiveKeyword } from '../src/verify.mjs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    'usage: phase-reconcile [--repo R] [--home H] [--apply] [--all] [--ticket T-... ] [--map ID="kw"] [--verbose]\n' +
    '  --apply   actually reconcile (default is dry-run).\n' +
    '  --all     also consider already-done tickets for reverse-drift reporting.\n' +
    '  --map ID="keyword"  explicit git-log keyword for a ticket id.\n'
  );
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const opt = { repo: process.cwd(), home: process.env.PHASE_HOME || './.phase', apply: false, all: false, verbose: false, tickets: [], map: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--apply') opt.apply = true;
    else if (a === '--all') opt.all = true;
    else if (a === '--verbose' || a === '-v') opt.verbose = true;
    else if (a === '--ticket') { let j = i + 1; while (j < argv.length && !argv[j].startsWith('--')) { opt.tickets.push(argv[j]); j++; } i = j - 1; }
    else if (a === '--map') { const kv = argv[++i]; const eq = kv.indexOf('='); if (eq <= 0) usage(`bad --map (want ID="kw"): ${kv}`); opt.map[kv.slice(0, eq)] = kv.slice(eq + 1).replace(/^["']|["']$/g, ''); }
    else if (a === '--help' || a === '-h') usage();
    else usage(`unknown option: ${a}`);
  }
  return opt;
}

/** True if any commit in the repo matches the keyword case-insensitively. */
function commitMatches(repo, keyword) {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch { return null; } // not a git repo
  try {
    const out = execFileSync(
      'git', ['-C', repo, 'log', '--all', '--oneline', '--grep', keyword, '-i', '-n', '1'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const line = out.trim();
    if (!line) return null;
    return line.split(' ')[0]; // short sha
  } catch { return null; }
}

// First 3 significant (length>3) non-stop words of an objective, joined.
function autoKeyword(objective) {
  // Shared matcher: significant words joined as a regex, so a commit subject
  // that IS the full objective matches even with interleaved stop-words.
  return objectiveKeyword(objective);
}

function depsDone(store, t) {
  for (const depId of t.depends_on ?? []) {
    const dep = store.getTicket(depId);
    if (!dep || dep.status !== 'done') return false;
  }
  return true;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const store = new TicketStore({ home: opt.home, repo: opt.repo });
  let tickets = store.listTickets();
  // Done (passed) tickets are compacted into .phase/archive by the store;
  // include them so --all can reverse-drift-audit completed work too.
  if (opt.all && typeof store.listArchive === 'function') {
    const archived = store.listArchive().map((r) => r.ticket ?? r).filter((t) => t && t.status === 'done');
    const have = new Set(tickets.map((t) => t.id));
    for (const t of archived) if (!have.has(t.id)) tickets.push(t);
  }
  if (opt.tickets.length) tickets = tickets.filter((t) => opt.tickets.includes(t.id));
  if (!tickets.length) { console.error('no tickets selected'); process.exit(0); }

  const plan = [];
  for (const t of tickets.sort((a, b) => a.id.localeCompare(b.id))) {
    const kw = opt.map[t.id] ?? autoKeyword(t.objective);
    const commit = commitMatches(opt.repo, kw);
    const gated = t.meta?.gating === true;
    const depsOk = t.meta?.gating === true ? depsDone(store, t) : true;
    plan.push({ t, kw, commit, gated, depsOk });
  }

  // ---- Report ----
  console.log(`PHASE RECONCILE  (${opt.apply ? 'APPLYING' : 'DRY-RUN — no changes will be made'})`);
  console.log(`repo=${opt.repo}  home=${opt.home}\n`);
  console.log('TICKET        STATUS    DEPOK GATED VERDICT      EVIDENCE');
  for (const p of plan) {
    const verdict = p.commit
      ? (p.t.status === 'done' ? 'drift-ok' : (p.gated && !p.depsOk ? 'blocked' : 'reconcile'))
      : 'unverified';
    console.log(
      `${p.t.id.padEnd(13)} ${p.t.status.padEnd(9)} ${String(!!p.depsOk).padEnd(5)} ${String(!!p.gated).padEnd(5)} ${verdict.padEnd(12)} ${p.commit ? p.commit : '—'}`,
    );
    if (opt.verbose) console.log(`    keyword: "${p.kw}"  objective: ${p.t.objective}`);
  }

  // ---- Apply (only with --apply, only reconcile verdict, only gated deps ok) ----
  if (!opt.apply) { console.log('\n(no changes applied; rerun with --apply to commit)' ); return; }

  let changed = 0;
  for (const p of plan) {
    if (p.t.status === 'done') continue;
    if (!p.commit) continue;                                  // no evidence
    if (p.gated && !p.depsOk) { console.log(`skip gated ${p.t.id} (deps not done)`); continue; }
    if (p.t.status === 'failed') { console.log(`skip failed ${p.t.id} (was explicitly failed)`); continue; }

    const result = `reconciled via git ${p.commit} (kw "${p.kw}")`;
    store.finish({ id: p.t.id, agent: 'phase-reconcile', passed: true, result, lock: null });
    store.control('ticket.reconcile', { ticket_id: p.t.id, source: 'phase-reconcile', commit: p.commit, keyword: p.kw, actor: 'cli', mode: 'git-evidence' });
    console.log(`  [${p.t.id}] marked done  ← ${result}`);
    changed++;
  }
  console.log(`\napplied ${changed} reconciliation(s)`);
}

main();
