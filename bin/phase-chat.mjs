#!/usr/bin/env node
/**
 * phase-chat — a human↔AI coordination chat over the same LLM provider.
 *
 * REPL mode (default): a conversational loop. The LLM brain replies in natural
 * language and bounded Phase instructions. Tickets stream onto the live bus
 * timeline as they're planned, run, and finish.
 *
 * Headless mode (--prompt): one shot, for wrapping agents.
 *
 * Gate: auto (default) runs tickets immediately; --permission asks you to
 * approve ("run") before scheduling. Toggle with "permission" / "auto" in-chat.
 */
import { createInterface } from 'node:readline';
import { ChatSession, parseIntent } from '../src/chat.mjs';
import { resolveProvider } from '../src/provider.mjs';
import { runWorker } from './phase-worker.mjs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scheduleIntent({ store, tickets, repo, policy, model, count }) {
  // Create tickets from the plan (ordinal DEPENDS resolved by create order).
  const created = [];
  const slot = [];
  for (const t of tickets) {
    const c = store.createTicket({ objective: t.objective, depends_on: t.depends_on ?? [] });
    created.push(c); slot.push(c.id);
  }
  for (let i = 0; i < created.length; i++) {
    const deps = [];
    for (const d of created[i].depends_on ?? []) {
      const m = /^T-(\d+)$/i.exec(d);
      if (m && slot[Number(m[1]) - 1]) deps.push(slot[Number(m[1]) - 1]);
    }
    if (deps.length) {
      const t = store.getTicket(created[i].id); t.depends_on = deps;
      const { writeFileSync } = await import('node:fs'); const { join } = await import('node:path');
      writeFileSync(join(store.ticketDir, `${t.id}.ticket.json`), JSON.stringify(t, null, 2));
    }
  }
  const anyOpen = () => store.listTickets().some((t) => t.status === 'open');
  const anyRun = () => store.listTickets().some((t) => t.status === 'in_progress');
  const workers = Array.from({ length: count }, (_, i) => (async () => {
    for (;;) {
      const r = await runWorker({ agent: `chatw${process.pid}.${i}`, repo, policy, model, command: null, store, env: process.env });
      if (r.status === 'no-ticket') { if (!anyOpen() && !anyRun()) break; await sleep(150); continue; }
      if (!anyOpen() && !anyRun()) break;
    }
  })());
  await Promise.all(workers);
  return created;
}

async function repl({ repo, model, planning, baseUrl, home, count, gate }) {
  const session = new ChatSession({ repo, model, planning_model: planning, base_url: baseUrl, home });
  let mode = gate || 'auto';
  let pendingApproval = null;
  console.log(`\n  Phase chat :: session ${session.id}`);
  console.log(`  model ${model}${planning && planning !== model ? ` (+planning ${planning})` : ''}  gate=${mode}  repo=${repo}\n`);
  console.log('  Commands:  permission | auto | quit | (plain messages to talk)\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const prompt = () => { rl.setPrompt('you> '); rl.prompt(); };
  prompt();

  rl.on('line', async (line) => {
    const msg = String(line).trim();
    if (!msg) { prompt(); return; }

    // gate approval pending?
    if (pendingApproval) {
      if (/^run$/i.test(msg)) {
        console.log(`[scheduler] running ${pendingApproval.tickets.length} ticket(s)...`);
        await scheduleIntent({ store: session.store, tickets: pendingApproval.tickets, repo, policy: 'heuristic', model, count });
        console.log('[scheduler] done.\n');
      } else {
        console.log('[gate] cancelled.\n');
      }
      pendingApproval = null;
      prompt(); return;
    }

    if (msg === 'quit' || msg === 'exit') { console.log('bye'); rl.close(); return; }
    if (msg === 'permission' || msg === 'auto') { mode = msg; console.log(`[gate] mode -> ${mode}\n`); prompt(); return; }

    const intent = await session.turn(msg, { permissionDefault: mode === 'permission' });
    if (intent.question) console.log(`brain> ${intent.question}\n`);
    else if (intent.raw) {
      const shown = intent.raw.split('\n').filter((l) => /^(TICKET|DEPENDS|CONSTRAINT|PERMISSION|RUN|STOP)/.test(l)).join('\n');
      console.log(`brain> ${shown || intent.raw.slice(0, 300)}\n`);
    }

    if (intent.tickets?.length && !intent.question) {
      const needApproval = intent.permission || mode === 'permission';
      if (needApproval) {
        console.log(`\n[ticket gate] propose ${intent.tickets.length} ticket(s). Reply "run" to schedule, anything else to cancel.`);
        pendingApproval = { tickets: intent.tickets };
      } else {
        console.log(`[scheduler] running ${intent.tickets.length} ticket(s)...`);
        await scheduleIntent({ store: session.store, tickets: intent.tickets, repo, policy: 'heuristic', model, count });
        console.log('[scheduler] done.\n');
      }
    }
    prompt();
  });

  await new Promise((res) => rl.on('close', res));
}

async function headless({ goal, repo, model, planning, baseUrl, home, count, gate }) {
  const session = new ChatSession({ repo, model, planning_model: planning, base_url: baseUrl, home });
  const intent = await session.turn(goal, { permissionDefault: gate === 'permission' });
  if (intent.question) { console.log(`brain> ${intent.question}`); return; }
  if (intent.tickets && intent.tickets.length) {
    if (intent.permission || gate === 'permission') { console.log(`[gate] pending ${intent.tickets.length} tickets (auto-approve with --gate auto)`); }
    else {
      await scheduleIntent({ store: session.store, tickets: intent.tickets, repo, policy: 'heuristic', model, count });
      console.log(`[scheduler] scheduled ${intent.tickets.length} ticket(s)`);
    }
  } else {
    console.log(`brain> ${intent.raw?.slice(0, 300) ?? '(no plan)'}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = { repo: process.cwd(), model: process.env.PHASE_LLM_MODEL ?? resolveProvider({ prefix: 'LLM' }).model, planning: process.env.PHASE_LLM_PLANNING ?? null, baseUrl: process.env.PHASE_LLM_BASE_URL ?? resolveProvider({ prefix: 'LLM' }).base_url, home: process.env.PHASE_HOME || './.phase', count: Math.max(1, (cpus().length || 2) - 1), gate: process.env.PHASE_GATE ?? 'auto', prompt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--model') opt.model = argv[++i];
    else if (a === '--planning') opt.planning = argv[++i];
    else if (a === '--base-url') opt.baseUrl = argv[++i];
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--count') opt.count = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--permission') opt.gate = 'permission';
    else if (a === '--gate') opt.gate = argv[++i] === 'permission' ? 'permission' : 'auto';
    else if (a === '--prompt') opt.prompt = argv[++i];
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else { console.error(`unknown option: ${a}`); usage(); process.exit(64); }
  }
  if (opt.prompt) await headless({ goal: opt.prompt, repo: opt.repo, model: opt.model, planning: opt.planning, baseUrl: opt.baseUrl, home: opt.home, count: opt.count, gate: opt.gate });
  else await repl({ ...opt });
}

function usage() {
  console.log(`phase-chat — talk to an LLM coordination brain.

Usage:
  phase-chat [--repo .] [--model m] [--gate auto|permission]     REPL
  phase-chat --prompt "goal" [...]                                 headless

Options:
  --repo <path>       repo to coordinate         (default: cwd)
  --model <id>        brain model                (default: $PHASE_LLM_MODEL or $PI_MODEL / chat model)
  --planning <id>     larger planning-LLM        (default: $PHASE_LLM_PLANNING)
  --base-url <url>    OpenAI-compatible endpoint (default: $PHASE_LLM_BASE_URL or :11434/v1)
  --count <n>         worker pool                (default: CPUs-1)
  --gate auto|permission  run now vs approve     (default: auto)
  --prompt "goal"     headless one-shot
  --home <path>       phase home                 (default: ./.phase)
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
