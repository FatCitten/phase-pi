#!/usr/bin/env node
/**
 * isa-bus — read, follow, and emit on the ISA buses.
 *
 *   isa-bus                              dump the last 40 control events
 *   isa-bus watch                        stream new control events
 *   isa-bus emit ping note=hello         append sig.ping to the control bus
 *   isa-bus --data                       operate on the data bus
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BusStore } from '../src/bus.mjs';

const SELF = fileURLToPath(import.meta.url);

export function usage() {
  return `isa-bus — read / follow / emit on the ISA buses

Usage:
  isa-bus [--bus control|data] [--tail N] [--follow] [--repo R] [--home H]
  isa-bus emit <type> [key=value ...] [--bus control|data] [--repo R] [--home H]
  isa-bus watch [--bus control|data] [--repo R] [--home H]

Options:
  --repo <path>      working dir recorded on events    (default: cwd)
  --home <path>      bus home                           (default: $ISA_HOME or ./.isa)
  --bus <name>       control | data                     (default: control)
  --tail <n>         how many events to dump            (default: 40)
  --follow, -f       stream new events
  --data             operate on the data bus
  --help, -h         show this help`;
}

function parseValue(v) {
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

const ENVELOPE = new Set(['seq', 'ts', 'bus', 'type', 'repo']);

function render(e) {
  const fields = Object.entries(e)
    .filter(([k]) => !ENVELOPE.has(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  return `${String((e.ts ?? '').slice(11, 19)).padEnd(9)} ${String(e.type).padEnd(22)} ${fields}`;
}

export async function main(argv = process.argv.slice(2)) {
  const opt = {
    repo: process.cwd(),
    home: process.env.ISA_HOME || './.isa',
    bus: 'control',
    tail: 40,
    follow: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage()); return; }
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--bus') opt.bus = argv[++i] ?? 'control';
    else if (a === '--tail') opt.tail = Number(argv[++i]) || 40;
    else if (a === '--follow' || a === '-f') opt.follow = true;
    else if (a === '--data') opt.bus = 'data';
    else if (a.startsWith('-')) { console.error(`isa-bus: unknown option: ${a}`); process.exit(64); }
    else positionals.push(a);
  }

  const store = new BusStore({ home: opt.home, repo: opt.repo });

  if (positionals[0] === 'emit') {
    const emitType = positionals[1];
    if (!emitType) { console.error('isa-bus: usage: isa-bus emit <type> [key=value ...]'); process.exit(64); }
    const fields = {};
    for (const kv of positionals.slice(2)) {
      const eq = kv.indexOf('=');
      if (eq > 0) fields[kv.slice(0, eq)] = parseValue(kv.slice(eq + 1));
      else fields[kv] = true;
    }
    const e = store.emit(opt.bus, emitType, fields);
    console.log(`emitted ${e.bus} sig.${emitType} seq=${e.seq} at ${e.ts}`);
    return;
  }

  if (positionals[0] === 'watch' || opt.follow) {
    let seen = store.read(opt.bus).length;
    const timer = setInterval(() => {
      const all = store.read(opt.bus);
      for (const e of all.slice(seen)) { seen++; console.log(render(e)); }
    }, 250);
    await new Promise(() => {}); // run forever
    clearInterval(timer);
    return;
  }

  const events = store.tail(opt.bus, opt.tail);
  for (const e of events) console.log(render(e));
  console.log(`\n${store.read(opt.bus).length} events on ${opt.bus} (showing last ${events.length})`);
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
