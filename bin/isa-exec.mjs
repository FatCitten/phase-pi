#!/usr/bin/env node
/**
 * isa-exec — run a command inside the active run's sandbox. Wall-time is
 * enforced by the engine: the child gets only the remaining budget and is
 * killed when it is gone. Output is captured to the run artifact + data bus.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';

const SELF = fileURLToPath(import.meta.url);

export function usage() {
  return `isa exec — run a command inside the active run's sandbox

Usage:
  isa exec <cmd...> [options]

Options:
  --home <path>      ISA home                 (default: $ISA_HOME or ./.isa)
  --repo <path>      working dir of the run   (default: cwd)
  --timeout <ms>     cap for this command     (default: remaining wall budget)
  --help, -h         show this help`;
}

export async function main(argv = process.argv.slice(2)) {
  const opt = { home: process.env.ISA_HOME || './.isa', repo: process.cwd(), timeout: null };
  const cmdParts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage()); return; }
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--timeout') opt.timeout = Number(argv[++i]) || null;
    else cmdParts.push(a);
  }
  const cmd = cmdParts.join(' ');
  if (!cmd.trim()) { console.log(usage()); process.exit(64); }

  const engine = new Engine({ home: opt.home, repo: opt.repo });
  const r = await engine.exec({ cmd, timeout: opt.timeout });
  process.stdout.write(r.out.endsWith('\n') ? r.out : r.out + '\n');
  console.error(`isa exec: ${r.kind} ${r.killed ? 'KILLED (wall budget)' : `exit ${r.code}`} in ${r.wall_ms}ms`);
  process.exitCode = r.killed ? 124 : r.code;
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
