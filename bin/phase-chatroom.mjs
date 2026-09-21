#!/usr/bin/env node
/**
 * phase-chatroom — an interactive terminal chat room.
 *
 * A raw-mode TUI where a human and multiple agents share one live room:
 *   - a scrollable conversation log (human + AI brain + agents),
 *   - a live bus timeline of tickets (control events) streaming in,
 *   - an input line at the bottom.
 *
 * Every human message goes through ChatSession (persisted to the data bus), so
 * the room is auditable and other agents joining see it too. Agents announce via
 * worker.up / worker.down and emit chat.agent signals on the bus. Tickets spawn
 * and finish live in the room.
 *
 * Works with any TTY; falls back to a plain interactive line mode if not a TTY.
 */
import { ChatSession } from '../src/chat.mjs';
import { resolveProvider } from '../src/provider.mjs';
import { TicketStore } from '../src/bus.mjs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

// --- ANSI helpers ---
const esc = '\x1b[';
const rst = `${esc}0m`;
const fg = (c, s) => `${esc}${c}m${s}${rst}`;
const COLORS = { human: 32, brain: 96, agent: 36, sys: 90, ticket: 33, ok: 32, fail: 31 };

function now() { return new Date().toTimeString().slice(0, 8); }

// --- minimal raw-mode terminal wrapper ---
class Term {
  constructor() { this.alive = true; this.input = ''; this.logPrefix = []; this.listeners = []; }
  raw() { if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8'); } }
  get height() { const h = process.stdout.rows; return (Number.isFinite(h) && h >= 8) ? h : 24; }
  get width() { const w = process.stdout.columns; return (Number.isFinite(w) && w >= 20) ? w : 80; }
  hide() { process.stdout.write(`${esc}?25l`); }
  show() { process.stdout.write(`${esc}?25h`); }
  goto(row) { const r = Math.max(1, Math.min(Math.round(row), this.height)); process.stdout.write(`${esc}${r};1H`); }
  cls() { process.stdout.write(`${esc}2J${esc}H`); }
  clearLine() { process.stdout.write(`${esc}2K`); }
}

export async function chatroom({ repo, model, planning, baseUrl, home, gate, name }) {
  const store = new TicketStore({ home, repo });
  const session = new ChatSession({ repo, model, planning_model: planning, base_url: baseUrl, home });
  const term = new Term();
  const roomName = name || `room-${session.id.split('-').at(-1)}`;
  let mode = gate || 'auto';

  // The room's collective log: {ts, who, color, text}.
  const log = [];
  const pushLog = (who, color, text) => { log.push({ ts: now(), who, color, text }); if (log.length > 500) log.shift(); };

  pushLog('SYS', COLORS.sys, `room ${roomName} open  (model ${model}${planning && planning !== model ? ` +plan ${planning}` : ''}  gate=${mode})`);
  pushLog('SYS', COLORS.sys, `type to talk;  'permission'/'auto' switch gate;  'quit' to leave`);

  // --- Poll the buses and stream new events into the room ---
  let seenControl = store.readControl().length;
  let seenData = store.readData().length;
  const watcher = setInterval(() => {
    const control = store.readControl();
    for (const e of control.slice(seenControl)) {
      seenControl++;
      const tid = e.ticket_id ?? '';
      switch (e.type) {
        case 'ticket.created': pushLog(tid, COLORS.ticket, `+ ticket: ${e.objective ?? ''}`); break;
        case 'ticket.claimed': pushLog('', COLORS.agent, `${tid} claimed by ${e.worker ?? '?'}`); break;
        case 'ticket.allocated': pushLog(tid, COLORS.ticket, `allocated (${e.policy})`); break;
        case 'ticket.done': pushLog(tid, COLORS.ok, `✓ done (${e.worker})`); break;
        case 'ticket.failed': pushLog(tid, COLORS.fail, `✗ failed (${e.worker})`); break;
        case 'worker.up': pushLog(e.worker ?? '', COLORS.agent, 'is here'); break;
        case 'worker.down': pushLog(e.worker ?? '', COLORS.agent, 'left'); break;
        default: break;
      }
    }
    const data = store.readData();
    for (const e of data.slice(seenData)) {
      seenData++;
      if (e.type === 'chat.user') pushLog('you', COLORS.human, String(e.content ?? '').slice(0, 200));
      else if (e.type === 'chat.assistant') pushLog('brain', COLORS.brain, String(e.content ?? '').slice(0, 200));
      else if (e.type === 'chat.agent' && e.worker) pushLog(e.worker, COLORS.agent, String(e.content ?? ''));
    }
    draw();
  }, 300);

  // --- render ---
  function draw() {
    if (!term.alive) return;
    const h = term.height, w = term.width;
    term.cls();
    // header
    term.goto(1);
    term.clearLine();
    process.stdout.write(fg(90, ` PHASE ROOM `) + fg(97, roomName) + fg(90, `  repo=${repo}  gate=${mode}  ${log.length} lines`));
    // body: last bodyH lines of the log, bottom-aligned above the input line.
    const bodyTop = 2;
    const bodyH = h - 4;
    const visible = log.slice(-bodyH);
    for (let i = 0; i < bodyH; i++) {
      term.goto(bodyTop + i);
      term.clearLine();
      const entry = visible[i - Math.max(0, bodyH - visible.length)] ?? null;
      if (!entry) continue;
      const who = (entry.who ? ` ${fg(COLORS[entry.who] ?? 90, entry.who.padEnd(6))}` : '        ');
      const line = `${fg(90, entry.ts)} ${who} ${fg(entry.color, entry.text)}`;
      process.stdout.write(line.slice(0, w - 1));
    }
    // footer input line
    const foot = h - 1;
    term.goto(foot);
    term.clearLine();
    process.stdout.write(fg(COLORS.human, ` you> `) + term.input);
  }

  // --- raw-mode keyboard handling ---
  function onData(chunk) {
    for (const ch of chunk) {
      const c = String(ch);
      if (c === '\x03' || c === '\x04') { process.stdout.write('\nbye\n'); term.alive = false; process.exit(0); }
      if (c === '\r' || c === '\n') { submit(term.input); term.input = ''; }
      else if (c === '\x7f' || c === '\b') term.input = term.input.slice(0, -1);
      else if (ch >= 0x20 && ch < 0x7f) term.input += c;
      draw();
    }
  }

  async function submit(lineMsg) {
    const msg = String(lineMsg).trim();
    if (!msg) { draw(); return; }
    if (msg === 'quit' || msg === 'exit') { process.stdout.write('\nbye\n'); term.alive = false; process.exit(0); }
    if (msg === 'permission' || msg === 'auto') { mode = msg; pushLog('SYS', COLORS.sys, `gate -> ${mode}`); draw(); return; }
    pushLog('you', COLORS.human, msg);
    const intent = await session.turn(msg, { permissionDefault: mode === 'permission' });
    if (intent.question) pushLog('brain', COLORS.brain, `? ${intent.question}`);
    else if (intent.raw) pushLog('brain', COLORS.brain, String(intent.raw).slice(0, 400));
    if (intent.tickets?.length && !intent.question) {
      const need = intent.permission || mode === 'permission';
      pushLog('SYS', need ? COLORS.ticket : COLORS.ok, need
        ? `proposed ${intent.tickets.length} ticket(s) — type 'run' to schedule`
        : `scheduling ${intent.tickets.length} ticket(s)...`);
      for (const t of intent.tickets) store.createTicket({ objective: t.objective, depends_on: t.depends_on ?? [] });
      if (!need) { scheduleTickets(intent.tickets); }
    }
    draw();
  }

  // Drain newly created tickets with a small in-room worker pool (auto gate).
  async function scheduleTickets(planTickets) {
    const count = Math.max(1, (cpus().length || 2) - 1);
    const { runWorker } = await import('./phase-worker.mjs');
    const anyOpen = () => store.listTickets().some((t) => t.status === 'open');
    const anyRun = () => store.listTickets().some((t) => t.status === 'in_progress');
    await Promise.all(Array.from({ length: count }, async (_, i) => {
      for (;;) {
        const r = await runWorker({ agent: `roomw${process.pid}.${i}`, repo, policy: 'heuristic', model, command: null, store, env: process.env });
        if (r.status === 'no-ticket') { if (!anyOpen() && !anyRun()) break; await new Promise((rs) => setTimeout(rs, 150)); continue; }
        if (!anyOpen() && !anyRun()) break;
      }
    }));
  }

  process.stdin.on('data', onData);
  term.raw();
  term.hide();
  process.stdout.on('resize', draw);

  term.cls();
  draw();

  await new Promise((res) => process.stdin.on('end', () => { clearInterval(watcher); res(); }));
}

// --- non-TTY fallback: simple line chat (for piping / agent use) ---
async function lineFallback(opts) {
  const { createInterface } = await import('node:readline');
  const store = new TicketStore({ repo: opts.repo });
  const session = new ChatSession({ repo: opts.repo, model: opts.model, planning_model: opts.planning, base_url: opts.baseUrl, home: opts.home });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`[chatroom] ${opts.name || session.id} (line mode)`);
  rl.setPrompt('you> ');
  rl.prompt();
  rl.on('line', async (line) => {
    const msg = String(line).trim();
    if (!msg) { rl.prompt(); return; }
    if (msg === 'quit') { rl.close(); return; }
    const intent = await session.turn(msg, { permissionDefault: opts.gate === 'permission' });
    console.log(`brain> ${intent.question ?? intent.raw ?? '(no plan)'}`);
    if (intent.tickets?.length && !intent.question && opts.gate !== 'permission') {
      for (const t of intent.tickets) store.createTicket({ objective: t.objective, depends_on: t.depends_on ?? [] });
      console.log(`[scheduler] ${intent.tickets.length} ticket(s) created`);
    }
    rl.prompt();
  });
}

export { lineFallback };

// --- CLI entry ---
if (process.argv[1]?.includes('phase-chatroom')) {
  const argv = process.argv.slice(2);
  const opt = { repo: process.cwd(), model: process.env.PHASE_LLM_MODEL ?? resolveProvider({ prefix: 'LLM' }).model, planning: process.env.PHASE_LLM_PLANNING ?? null, baseUrl: process.env.PHASE_LLM_BASE_URL ?? resolveProvider({ prefix: 'LLM' }).base_url, home: process.env.PHASE_HOME || './.phase', gate: process.env.PHASE_GATE ?? 'auto', name: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--model') opt.model = argv[++i];
    else if (a === '--planning') opt.planning = argv[++i];
    else if (a === '--base-url') opt.baseUrl = argv[++i];
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--gate') opt.gate = argv[++i] === 'permission' ? 'permission' : 'auto';
    else if (a === '--name') opt.name = argv[++i];
    else if (a === '-h' || a === '--help') { console.log('phase-chatroom — interactive terminal chat room.\n   --repo --model --planning --base-url --gate --home --name\n   Falls back to line mode when not a TTY.'); process.exit(0); }
    else { console.error(`unknown option: ${a}`); process.exit(64); }
  }
  if (process.stdin.isTTY && process.stdout.isTTY) chatroom(opt);
  else lineFallback(opt);
}
