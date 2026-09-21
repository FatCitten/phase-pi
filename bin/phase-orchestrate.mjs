#!/usr/bin/env node
/**
 * phase-orchestrate — let the SLM drive the whole coordination loop autonomously.
 *
 *   1. DECOMPOSE: SLM turns a human goal into a ticket pipeline (TICKET/DEPENDS).
 *   2. RUN:       drain-loop scheduler runs the tickets with a parallel worker pool.
 *   3. REVIEW:    SLM reads outcomes and decides RETRY / ADD / STOP.
 *   4. LOOP:      repeat until the SLM says STOP or the round cap is hit.
 *
 * Pure Node stdlib. Offline fallback keeps it running without an SLM endpoint.
 *
 * Usage:
 *   phase-orchestrate "ship offline auth with tests" --repo . --rounds 3 --count 4
 */
import { TicketStore } from '../src/bus.mjs';
import { decomposeGoal, decideNext } from '../src/orchestrator.mjs';
import { slmProvider } from '../src/provider.mjs';
import { runWorker } from './phase-worker.mjs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';

const VERBOSE = process.env.PHASE_ORCH_VERBOSE !== '0';
const say = (s) => { if (VERBOSE) console.log(s); };

async function main() {
  const argv = process.argv.slice(2);
  const opt = {
    repo: process.cwd(), goal: null, rounds: 3,
    count: Math.max(1, (cpus().length || 2) - 1),
    policy: process.env.PHASE_SLM_POLICY ?? 'heuristic',
    model: slmProvider().model,      // $PI_MODEL-aware; override via PHASE_SLM_MODEL / --model
    base_url: slmProvider().base_url,
    home: process.env.PHASE_HOME || './.phase', dryRun: false, exec: null, stream: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--rounds') opt.rounds = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--count') opt.count = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--policy') opt.policy = argv[++i] ?? 'heuristic';
    else if (a === '--model') opt.model = argv[++i];
    else if (a === '--base-url') opt.base_url = argv[++i];
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a === '--exec') opt.exec = argv[++i];
    else if (a === '--stream') opt.stream = true;
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); usage(); process.exit(64); }
    else opt.goal = (opt.goal ? opt.goal + ' ' : '') + a;
  }
  if (!opt.goal) { usage(); process.exit(64); }

  say(`[orchestrate] goal: ${opt.goal}\n  repo=${opt.repo} rounds=${opt.rounds} workers=${opt.count} policy=${opt.policy} model=${opt.model}`);

  // 1. DECOMPOSE
  say(`\n[1] SLM decomposing goal into tickets ...`);
  const plan = await decomposeGoal({ goal: opt.goal, repo: opt.repo, model: opt.model, base_url: opt.base_url, fallback: true });
  if (plan.model_error) say(`  (SLM unavailable; deterministic fallback: ${plan.model_error})`);
  say(`  plan: ${plan.tickets.length} ticket(s)`);
  plan.tickets.forEach((t, i) => say(`    T${i + 1}: ${t.objective}${t.depends_on.length ? '  [depends ' + t.depends_on.join(',') + ']' : ''}`));
  if (opt.dryRun) return;

  const store = new TicketStore({ home: opt.home, repo: opt.repo });

  const outcomes = []; // persistent across rounds
  const createdIds = [];

  for (let round = 1; round <= opt.rounds; round++) {
    say(`\n===== ROUND ${round}/${opt.rounds} =====`);

    // Create NEW tickets for this round (from decomposition on round 1, ADD/retry later).
    const toCreate = round === 1 ? plan.tickets : (opt.candidateTickets ?? []);
    const roundCreated = [];
    const createdIdx = []; // ordinal slots: createdIdx[roundIdx] = ticket.id
    for (const t of toCreate) {
      const c = store.createTicket({ objective: t.objective, depends_on: t.depends_on ?? [] });
      createdIds.push(c.id); roundCreated.push(c); createdIdx.push(c.id);
      say(`  + ${c.id}  ${t.objective}`);
    }
    // Resolve ordinal DEPENDS (T-1, T-2) emitted by the SLM against tickets
    // created this round; real UUID deps are left as-is.
    for (let ri = 0; ri < roundCreated.length; ri++) {
      const t = roundCreated[ri];
      const real = [];
      for (const d of t.depends_on ?? []) {
        const m = /^T-(\d+)$/i.exec(d);
        if (m && createdIdx[Number(m[1]) - 1]) real.push(createdIdx[Number(m[1]) - 1]);
        else if (store.getTicket(d)) real.push(d);
      }
      if (real.length) {
        t.depends_on = [...new Set(real)];
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        writeFileSync(join(store.ticketDir, `${t.id}.ticket.json`), JSON.stringify(t, null, 2));
      }
    }
    opt.candidateTickets = []; // consume

    // 2. RUN drain loop
    const anyOpen = () => store.listTickets().some((t) => t.status === 'open');
    const anyRun = () => store.listTickets().some((t) => t.status === 'in_progress');
    const workers = Array.from({ length: opt.count }, (_, i) => (async () => {
      for (;;) {
        const r = await runWorker({ agent: `o${process.pid}.${round}.${i}`, repo: opt.repo, policy: opt.policy, model: opt.model, command: opt.exec, store, env: process.env });
        if (r.status === 'no-ticket') { if (!anyOpen() && !anyRun()) break; await new Promise((r2) => setTimeout(r2, 120)); continue; }
        outcomes.push(r);
        if (r.status === 'done') say(`  ✓ ${r.ticket_id} done (${r.wall_ms}ms)`);
        else if (r.status === 'failed') say(`  ✗ ${r.ticket_id} failed`);
        if (!anyOpen()) break;
      }
    })());
    await Promise.all(workers);

    const roundDone = outcomes.filter((o) => o.passed).length;
    const roundFailed = outcomes.filter((o) => !o.passed);

    // 3. REVIEW via SLM
    say(`\n[review] round done: ${roundDone} done, ${roundFailed.length} failed`);
    const decision = await decideNext({ goal: opt.goal, outcomes, repo: opt.repo, model: opt.model, base_url: opt.base_url, fallback: true });
    if (decision.model_error) say(`  (SLM unavailable; fallback decision)`);
    if (decision.retries.length) say(`  SLM -> RETRY: ${decision.retries.join(', ')}`);
    if (decision.adds.length) say(`  SLM -> ADD: ${decision.adds.map((a) => a.objective).join(' | ')}`);
    if (decision.stop) say(`  SLM -> STOP`);

    // Retry failed tickets by reopening them (clear lock + reset).
    if (decision.retries.length) {
      for (const id of decision.retries) {
        const t = store.getTicket(id);
        if (t && t.status === 'failed') {
          t.status = 'open'; t.claimed_by = null; t.result = null; delete t.artifact;
          const { writeFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          writeFileSync(join(store.ticketDir, `${id}.ticket.json`), JSON.stringify(t, null, 2));
          store.control('ticket.requeued', { ticket_id: id });
          say(`  ↻ requeued ${id}`);
        }
      }
    }
    // Follow-ups become next round's tickets.
    if (decision.adds.length) opt.candidateTickets = decision.adds;

    if (decision.stop) { say(`\n[orchestrate] SLM marked work complete after round ${round}.`); break; }
    if (!decision.retries.length && !decision.adds.length && round > 1) { say(`[orchestrate] idle — no retries/follow-ups requested, finishing.`); break; }
  }

  const finalDone = store.listTickets().filter((t) => t.status === 'done').length;
  const finalFailed = store.listTickets().filter((t) => t.status === 'failed').length;
  const finalOpen = store.listTickets().filter((t) => t.status === 'open').length;
  console.log(`\n[orchestrate] FINAL: ${finalDone} done, ${finalFailed} failed, ${finalOpen} still open over ${createdIds.length} tickets`);
  process.exitCode = finalFailed ? 2 : 0;
}

function usage() {
  console.log(`phase-orchestrate — an SLM drives the full coordination loop.

Usage:
  phase-orchestrate "human goal" [options]

Steps (repeated until SLM says STOP):
  1. SLM decomposes the goal into tickets (TICKET / DEPENDS).
  2. Drain-loop scheduler runs them with a parallel worker pool.
  3. SLM reviews outcomes -> RETRY failed / ADD follow-ups / STOP.

Options:
  --repo <path>       repo to coordinate            (default: cwd)
  --rounds <n>        max loops                     (default: 3)
  --count <n>         concurrent workers per round  (default: CPUs-1)
  --policy model|h    SLM or heuristic allocation   (default: heuristic)
  --model <id>        SLM model                     (default: $PHASE_SLM_MODEL or $PI_MODEL / chat model)
  --base-url <url>    OpenAI-compatible endpoint    (default: $PHASE_SLM_BASE_URL or pi/Ollama 11434)
  --exec <cmd>        run this command per ticket (else built-in demo job)
  --dry-run           decompose + report only
  --help              show this
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
