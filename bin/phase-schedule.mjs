#!/usr/bin/env node
/**
 * Phase coordinator — build a ticket queue and brute-force it with concurrent
 * SLM workers. Supports dependency chains (pipelines) and drains until done.
 * Pure Node stdlib.
 *
 * Usage:
 *   phase schedule "obj A" "obj B" ...            independent fan-out
 *   phase schedule --pipeline "s1" "s2" "s3"       linear chain (each depends on prev)
 *   phase schedule --dag a.json                    graph: [{objective, depends_on:[...]}]
 *
 * The drain loop keeps dispatching workers over claimable tickets until NO
 * ticket remains (open or blocked-by-missing-deps). A linear pipeline therefore
 * SERIALIZES even under a parallel worker pool — the classic hard-to-parallelize
 * case — while independent branches fan out.
 */
import { TicketStore } from '../src/bus.mjs';
import { slmProvider } from '../src/provider.mjs';
import { runWorker } from './phase-worker.mjs';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
  console.log(`phase schedule — tickets in, concurrency out.

Usage:
  phase schedule "obj 1" ["obj 2" ...]         independent tickets
  phase schedule --pipeline "s1" "s2" "s3"      linear chain (s2 depends on s1, etc.)
  phase schedule --dag graph.json --exec "npm test"

Options:
  --repo <path>       repo to coordinate            (default: cwd)
  --count <n>         max concurrent workers        (default: CPUs - 1)
  --policy model|h    SLM or heuristic allocation   (default: heuristic)
  --model <id>        SLM model id                  (default: $PHASE_SLM_MODEL or $PI_MODEL / chat model)
  --exec <cmd>        run this command per ticket (else built-in demo job)
  --pipeline          treat positional objectives as a linear dependent chain
  --dag <file>        JSON graph [{objective, depends_on:[...]}]
  --tickets <file>    JSON file with string[] objectives
  --home <path>       phase home (default: ./.phase)
  --dry-run           create tickets only, don't run workers
  --help              show this
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = { repo: process.cwd(), count: Math.max(1, (cpus().length || 2) - 1), policy: 'heuristic', model: process.env.PHASE_SLM_MODEL ?? slmProvider().model, exec: null, pipeline: false, dagFile: null, ticketsFile: null, home: process.env.PHASE_HOME || './.phase', dryRun: false };
  const objectives = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--count') opt.count = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--policy') opt.policy = argv[++i] ?? 'heuristic';
    else if (a === '--model') opt.model = argv[++i];
    else if (a === '--exec') opt.exec = argv[++i];
    else if (a === '--pipeline') opt.pipeline = true;
    else if (a === '--dag') opt.dagFile = argv[++i];
    else if (a === '--tickets') opt.ticketsFile = argv[++i];
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--dry-run') opt.dryRun = true;
    else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); usage(); process.exit(64); }
    else objectives.push(a);
  }

  const store = new TicketStore({ home: opt.home, repo: opt.repo });
  const tickets = {};
  const created = [];

  const make = ({ objective, depends_on }) => { const t = store.createTicket({ objective, depends_on }); tickets[t.id] = t; created.push(t); return t; };

  // Build the queue.
  if (opt.dagFile) {
    const graph = JSON.parse(readFileSync(resolve(opt.dagFile), 'utf8'));
    for (const node of graph) make({ objective: node.objective ?? node.task, depends_on: node.depends_on ?? [] });
  } else if (opt.ticketsFile) {
    const raw = JSON.parse(readFileSync(resolve(opt.ticketsFile), 'utf8'));
    const arr = Array.isArray(raw) ? raw : raw.objectives ?? raw.tickets ?? [];
    for (const o of arr) make({ objective: typeof o === 'string' ? o : o.objective ?? o.task, depends_on: o.depends_on });
  } else if (opt.pipeline) {
    // Linear chain: each depends on the previous.
    let prev = null;
    for (const o of objectives) { const t = make({ objective: o, depends_on: prev ? [prev] : [] }); prev = t.id; }
  } else {
    for (const o of objectives) make({ objective: o });
  }

  if (!created.length) { console.error('no objectives given'); usage(); process.exit(64); }
  console.log(`tickets: ${created.length} (${opt.pipeline ? 'linear pipeline' : opt.dagFile ? 'DAG' : 'independent'}); workers: ${opt.count}; policy: ${opt.policy}; repo: ${opt.repo}`);

  if (opt.dryRun) {
    for (const t of created) console.log(`  ${t.id}\tdepends=${(t.depends_on||[]).join(',')||'-'}\t${t.objective}`);
    return;
  }

  // --- DRAIN LOOP: keep dispatching workers until no claimable ticket remains
  // and nothing is in progress. A linear chain therefore runs serially no
  // matter how many workers are in the pool.
  const startedAt = Date.now();
  const poolId = `pool${process.pid}`;
  store.control('pool.start', { pool: poolId, workers: opt.count });

  let finished = 0;
  const done = () => finished++;
  const worker = async (poolIdIndex) => {
    for (;;) {
      const r = await runWorker({ agent: `w${poolId}.${poolIdIndex}`, repo: opt.repo, policy: opt.policy, model: opt.model, command: opt.exec, store, env: process.env });
      if (r.status === 'no-ticket') {
        // Maybe nothing is claimable yet (blocked on deps) but work remains.
        const remaining = store.listTickets().filter((t) => t.status === 'open' || t.status === 'in_progress' || !store.getTicket(t.id));
        const anyOpen = store.listTickets().some((t) => t.status === 'open');
        const anyRunning = store.listTickets().some((t) => t.status === 'in_progress');
        if (!anyOpen && !anyRunning) break; // fully drained
        await sleep(120); // deps will unblock; retry
        continue;
      }
      done(); // 'done' or 'failed'
      // After completing, keep pulling until the queue is empty.
      const anyOpen = store.listTickets().some((t) => t.status === 'open');
      if (!anyOpen) break;
    }
  };

  const pool = Array.from({ length: opt.count }, (_, poolIdIndex) => worker(poolIdIndex));
  await Promise.all(pool);

  const elapsedMs = Date.now() - startedAt;
  store.control('pool.done', { pool: poolId, finished, elapsed_ms: elapsedMs });
  console.log(`\nfinished ${finished} tickets in ${elapsedMs}ms`);

  // Report timeline of claim/done per ticket (shows serialization for pipelines).
  const control = store.readControl();
  const timeline = new Map(); // ticket_id -> {start, done, worker}
  for (const e of control) {
    if (e.type === 'ticket.started') { const x = timeline.get(e.ticket_id) ?? {}; x.t0 = e.ts; x.worker = e.worker; timeline.set(e.ticket_id, x); }
    if (e.type === 'ticket.done' || e.type === 'ticket.failed') { const x = timeline.get(e.ticket_id) ?? {}; x.t1 = e.ts; x.worker = e.worker; x.status = e.type === 'ticket.done' ? 'done' : 'FAIL'; timeline.set(e.ticket_id, x); }
  }
  const order = [...timeline.entries()].sort((a, b) => String(a[1].t1 ?? a[1].t0).localeCompare(String(b[1].t1 ?? b[1].t0)));
  console.log(`\n${'TICKET'.padEnd(13)} ${'ORDER'.padEnd(6)} ${'STATUS'.padEnd(7)} ${'WORKER'.padEnd(10)} OBJECTIVE`);
  let o = 1;
  for (const [tid, x] of order) {
    console.log(`${tid.padEnd(13)} ${String(o++).padEnd(6)} ${String(x.status ?? 'started').padEnd(7)} ${String(x.worker ?? '').padEnd(10)} ${store.getTicket(tid)?.objective ?? ''}`);
  }

  const failed = store.listTickets().filter((t) => t.status === 'failed');
  process.exitCode = failed.length ? 2 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
