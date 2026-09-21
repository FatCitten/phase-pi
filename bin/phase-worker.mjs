#!/usr/bin/env node
/**
 * Phase worker — runs as an SLM agent. Claims a ticket, allocates FRESH context
 * for it (own git snapshot + nonce), runs the job, and records the outcome on the
 * control + data buses.
 *
 * Multiple workers can run concurrently on the same repo; each claims a distinct
 * open ticket atomically, so jobs never collide. Every ticket gets fresh context
 * (isolated allocation, repo snapshot, nonce) — nothing is reused across tickets.
 */
import { TicketStore } from '../src/bus.mjs';
import { PhaseAllocator, allocationToAssembly } from '../src/allocator.mjs';
import { gitSnapshot } from '../src/util.mjs';
import { slmProvider } from '../src/provider.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(msg, code = 64) { console.error(`phase worker: ${msg}`); process.exit(code); }

export async function runWorker({ ticket_id, agent, repo, policy, model, command, store = null, env, verbose = true }) {
  store = store ?? new TicketStore({ repo });
  store.workerUp(agent);

  const claim = store.claim({ ticket_id, agent });
  if (!claim) {
    if (verbose) console.error(`[worker ${agent}] no open ticket (${ticket_id ? 'already claimed/held: ' + ticket_id : 'all claimed'})`);
    store.workerDown(agent);
    return { status: 'no-ticket' };
  }
  const { ticket, lock } = claim;
  if (verbose) console.log(`[worker ${agent}] claimed ${ticket.id}: ${ticket.objective}`);
  store.start(ticket.id, agent);

  // FRESH CONTEXT: per-ticket snapshot + allocation. Nothing shared between tickets.
  const fresh = store.snapshot();
  const wf = {
    id: ticket.id, objective: ticket.objective, cwd: repo,
    constraints: [], decisions: [],
    defaults: { agent: 'auto', budget: { tokens: 24000, context_tokens: 12000, wall_ms: 300000, tool_calls: 30 } },
    fibers: [{ id: 'F1', objective: ticket.objective, depends_on: [], agent: 'auto', tools: ['read', 'edit', 'test', 'bash'], budget: { tokens: 24000, context_tokens: 12000, wall_ms: 300000, tool_calls: 30 }, validation: [] }],
    allocator: { policy, base_url: String(env.PHASE_SLM_BASE_URL ?? slmProvider().base_url), model, required: false }
  };
  const allocator = new PhaseAllocator({ policy, model: { base_url: wf.allocator.base_url, model, timeout_ms: 30000 } });
  const allocation = await allocator.allocate({ workflow: wf, fiber: wf.fibers[0], runtime: {}, availableAgents: [] });

  // Put fresh context on the DATA bus (machine-consumed) and the decision on CONTROL.
  store.data('ticket.context', {
    ticket_id: ticket.id, worker: agent,
    repo_snapshot: fresh, allocation: { agent: allocation.agent, tools: allocation.tools, budget: allocation.budget, policy: allocation.policy },
    isa: allocation.asm
  });
  store.control('ticket.allocated', { ticket_id: ticket.id, worker: agent, policy: allocation.policy, isa: allocation.asm, model });

  const startedAt = Date.now();
  if (verbose) console.log(`[worker ${agent}] allocated ${allocation.policy} budget ${allocation.budget.tokens} tokens / ${allocation.budget.wall_ms}ms`);

  // Run the ticket's job. If an explicit command is given, spawn it; else run a
  // built-in demo job that touches a per-ticket artifact in the repo (so concurrent
  // workers visibly make independent progress).
  const job = command
    ? runCommand(command, { ticket, repo, allocation, fresh, agent })
    : runDemoJob({ ticket, repo, allocation, fresh, agent, store });

  let outcome;
  try {
    outcome = await job;
  } catch (e) {
    outcome = { passed: false, result: String(e.message || e), artifact: null };
  }
  const wallMs = Date.now() - startedAt;

  const r = {
    ticket_id: ticket.id, worker: agent, wall_ms: wallMs, passed: Boolean(outcome.passed),
    result: outcome.result, artifact: outcome.artifact, policy: allocation.policy
  };
  const done = store.finish({ id: ticket.id, agent, passed: r.passed, result: r.result, artifact: r.artifact, lock });
  store.workerDown(agent);
  if (verbose) console.log(`[worker ${agent}] ${r.passed ? 'DONE' : 'FAIL'} ${ticket.id} in ${wallMs}ms`);
  return { status: r.passed ? 'done' : 'failed', ...r, ticket: done };
}

function runCommand(command, { ticket, repo, allocation, fresh, agent }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [], {
      shell: true, cwd: repo,
      env: {
        ...process.env,
        PHASE_TICKET: ticket.id, PHASE_OBJECTIVE: ticket.objective, PHASE_WORKER: agent,
        PHASE_FRESH_NONCE: fresh.nonce, PHASE_REPO: repo,
        PHASE_ALLOC_ISA: allocation.asm, PHASE_ALLOC_BUDGET: JSON.stringify(allocation.budget)
      }
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ passed: code === 0, result: (out || err).trim() || `exit ${code}`, artifact: null }));
  });
}

function runDemoJob({ ticket, repo, allocation, fresh, agent, store }) {
  // Each worker writes its OWN artifact file (keyed by nonce), so concurrent
  // workers on the same repo never collide. For a pipeline ticket with deps,
  // it reads and echoes its completed dependencies' artifacts — demonstrating
  // that state flows through the chain serially.
  return new Promise((resolve) => {
    setTimeout(() => {
      const artifact = join(repo, '.phase', 'artifacts', `${ticket.id}-${fresh.nonce.slice(0, 8)}.txt`);
      try {
        // Consume dependency outputs so a pipeline provably serializes.
        let depEcho = '';
        for (const depId of ticket.depends_on ?? []) {
          const dt = store.getTicket(depId);
          if (dt?.status === 'done' && dt.artifact) {
            try { depEcho += `dep ${depId}: ${readFileSync(dt.artifact, 'utf8').split('\n')[0]}\n`; } catch { depEcho += `dep ${depId}: (unreadable)\n`; }
          } else depEcho += `dep ${depId}: MISSING (not done) → ORDERING VIOLATION\n`;
        }
        mkdirSync(join(repo, '.phase', 'artifacts'), { recursive: true });
        writeFileSync(artifact,
          `ticket=${ticket.id}\nworker=${agent}\nrepo=${repo}\ncommit=${fresh.commit}\nnonce=${fresh.nonce}\ndeps=${(ticket.depends_on||[]).join(',')||'-'}\n${depEcho}` +
          `budget=${allocation.budget.context_tokens} ctx / ${allocation.budget.tokens} tok / ${allocation.budget.wall_ms}ms\n` +
          `isa:\n${allocation.asm}\n`);
        resolve({ passed: true, result: artifact, artifact });
      } catch (e) {
        resolve({ passed: false, result: String(e.message || e), artifact: null });
      }
    }, 50 + Math.floor(Math.random() * 300)); // jitter so "parallel" is visible
  });
}

if (process.argv[1] && process.argv[1].includes('worker')) {
  const a = process.argv.slice(2);
  const opt = { ticket_id: null, agent: `w${process.pid}`, repo: process.cwd(), policy: process.env.PHASE_SLM_POLICY ?? 'heuristic', model: process.env.PHASE_SLM_MODEL ?? slmProvider().model, command: null };
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--ticket') opt.ticket_id = a[++i];
    else if (x === '--agent') opt.agent = a[++i];
    else if (x === '--repo') opt.repo = a[++i];
    else if (x === '--policy') opt.policy = a[++i];
    else if (x === '--model') opt.model = a[++i];
    else if (x === '--exec') opt.command = a[++i];
    else fail(`unknown option: ${x}`);
  }
  runWorker(opt).then((r) => r.status === 'done' ? process.exit(0) : process.exit(r.status === 'failed' ? 2 : 0)).catch((e) => { console.error(e); process.exit(1); });
}
