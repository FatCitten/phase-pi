#!/usr/bin/env node
/**
 * Phase bus/ticket inspector — read or follow the coordination buses and list
 * ticket state. Pure Node stdlib.
 *
 *   phase bus                dump full control + data buses (last 40 control events)
 *   phase bus --follow       stream new control events as they arrive
 *   phase bus --data         dump the data bus
 *   phase tickets            list tickets with status
 *   phase ticket <id>        show one ticket
 */
import { TicketStore } from '../src/bus.mjs';
import { resolve } from 'node:path';

/**
 *   phase emit <type> [key=value ...] [--bus control|data] [--repo R]
 *     → append a signal another agent can watch/react to.
 *   phase watch [--follow] [--bus control|data]
 *     → read/stream bus events.
 */

function pad(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); }

function mainline() {
  const argv = process.argv.slice(2);
  const opt = { repo: process.cwd(), follow: false, data: false, home: process.env.PHASE_HOME || './.phase', cmd: null, ticketId: null, emitType: null, emitFields: {}, bus: 'control' };
  const positionals = [];
  let afterEmit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--follow' || a === '-f') opt.follow = true;
    else if (a === '--data') opt.data = true;
    else if (a === '--bus') opt.bus = argv[++i] ?? 'control';
    else if (!a.startsWith('-') && positionals[0] === 'emit' && !opt.emitType) opt.emitType = a;
    else if (!a.startsWith('-') && positionals[0] === 'emit' && opt.emitType) { const eq = a.indexOf('='); if (eq > 0) opt.emitFields[a.slice(0, eq)] = parseValue(a.slice(eq + 1)); }
    else if (!a.startsWith('-') && !opt.cmd) { opt.cmd = a; positionals.push(a); }
    else if (!a.startsWith('-') && opt.cmd === 'ticket' && !opt.ticketId) opt.ticketId = a;
    else if (!a.startsWith('-')) {}
    else { console.error(`unknown option: ${a}`); process.exit(64); }
  }
  if (opt.cmd === 'emit') { opt.emitType = opt.emitType ?? positionals[1]; }
  return opt;
}

function parseValue(v) {
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function renderControl(e) {
  const who = e.worker ?? '';
  return `${pad((e.ts ?? '').slice(11, 19), 9)} ${pad(e.type, 20)} ${pad(e.ticket_id ?? '', 12)} ${who}`;
}

async function follow(store) {
  let seen = store.readControl().length;
  const interval = setInterval(() => {
    const all = store.readControl();
    for (const e of all.slice(seen)) { seen++; console.log(renderControl(e)); }
  }, 250);
  await new Promise(() => {}); // run forever
  clearInterval(interval);
}

function dump(opt) {
  const store = new TicketStore({ home: opt.home, repo: opt.repo });
  const cmd = opt.cmd;
  if (cmd === 'emit') {
    if (!opt.emitType) { console.error('usage: phase emit <type> [key=value ...] [--bus control|data]'); process.exit(64); }
    const e = store.emit(opt.bus, opt.emitType, opt.emitFields);
    console.log(`emitted ${e.bus} sig.${opt.emitType} seq=${e.seq} at ${e.ts}`);
    return;
  }
  if (cmd === 'bus' || cmd === 'watch') {
    const data = opt.bus === 'data' ? store.readData() : store.readControl();
    const list = data.slice(-40);
    for (const e of list) console.log(`${renderControl(e)} ${opt.bus === 'data' ? '  ' + JSON.stringify(e).slice(0, 80) : ''}`);
    console.log(`\n${data.length} events (showing last ${list.length})`);
    return;
  }
  if (cmd === 'tickets') {
    const tickets = store.listTickets();
    console.log(`${'TICKET'.padEnd(13)} ${'STATUS'.padEnd(13)} ${'WORKER'.padEnd(10)} OBJECTIVE`);
    for (const t of tickets.sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`${pad(t.id, 13)} ${t.status.padEnd(13)} ${pad(t.claimed_by ?? '', 10)} ${pad(t.objective, 60)}`);
    }
    console.log(`\n${tickets.length} tickets`);
    return;
  }
  if (cmd === 'ticket') {
    const t = store.getTicket(opt.ticketId);
    if (!t) { console.error(`no ticket ${opt.ticketId}`); process.exit(2); }
    console.log(JSON.stringify(t, null, 2));
    return;
  }
  console.error(`unknown command: ${cmd ?? '(none)'} (use: phase bus | phase tickets | phase ticket <id> | phase emit)`);
  process.exit(64);
}

function main() {
  const opt = mainline();
  const store = new TicketStore({ home: opt.home, repo: opt.repo });
  if (opt.follow) return follow(store);
  dump(opt);
}

main();
