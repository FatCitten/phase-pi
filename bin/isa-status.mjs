#!/usr/bin/env node
/**
 * isa-status — the program counter: budget vs actuals so far, wall remaining.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';

const SELF = fileURLToPath(import.meta.url);

export function usage() {
  return `isa status — the program counter of the active run

Usage:
  isa status [options]

Options:
  --home <path>      ISA home                 (default: $ISA_HOME or ./.isa)
  --repo <path>      working dir of the run   (default: cwd)
  --json             print the status object as JSON
  --help, -h         show this help`;
}

export async function main(argv = process.argv.slice(2)) {
  const opt = { home: process.env.ISA_HOME || './.isa', repo: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage()); return; }
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--json') opt.json = true;
    else { console.error(`isa status: unknown option: ${a}`); process.exit(64); }
  }

  const engine = new Engine({ home: opt.home, repo: opt.repo });
  const s = engine.status();
  if (!s.active) {
    if (opt.json) console.log(JSON.stringify({ active: false }));
    else console.log('no active run — isa begin first');
    return;
  }
  if (opt.json) { console.log(JSON.stringify(s, null, 2)); return; }
  const { actuals, budget, remaining } = s;
  const row = (name, used, cap) => `${name.padEnd(14)} ${String(used ?? '-').padEnd(10)} / ${cap}${used != null && Number(used) > Number(cap) ? '  OVER' : ''}`;
  console.log(`RUN ${s.id} — ${s.task}`);
  console.log(`sandbox: ${s.sandbox}`);
  console.log(`elapsed: ${actuals.wall_ms}ms`);
  console.log(`  ${row('wall_ms', actuals.wall_ms, budget.wall_ms)}   remaining ${remaining}ms`);
  console.log(`  ${row('tool_calls', actuals.tool_calls, budget.tool_calls)}${actuals.tool_calls === null ? '   (harness hook inactive)' : ''}`);
  console.log(`  ${row('tokens', actuals.tokens, budget.tokens)}${actuals.tokens === null ? '   (harness hook inactive)' : ''}`);
  console.log(`  ${row('exec_count', actuals.exec_count, '-')}`);
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
