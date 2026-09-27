#!/usr/bin/env node
/**
 * isa-status — the run facts: what is running, for how long, what it has done.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';

const SELF = fileURLToPath(import.meta.url);

export function usage() {
  return `isa status — the run facts: what is running, for how long, what it has done

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
  const { actuals } = s;
  console.log(`RUN ${s.id} — ${s.task}`);
  console.log(`sandbox: ${s.sandbox}`);
  console.log(`started: ${s.started_at}`);
  console.log(`elapsed: ${actuals.wall_ms}ms · exec_count ${actuals.exec_count}`);
  console.log(`tool_calls: ${actuals.tool_calls === null ? '- (harness hook inactive)' : actuals.tool_calls}`);
  console.log(`tokens: ${actuals.tokens === null ? '- (harness hook inactive)' : actuals.tokens}`);
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
