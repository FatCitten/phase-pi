#!/usr/bin/env node
/**
 * isa-end — close the active run. The engine measures wall_ms itself and
 * records the outcome. Nothing is checked against anything; the record is
 * the truth.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';

const SELF = fileURLToPath(import.meta.url);

export function usage() {
  return `isa end — close the active run (engine-measured, never self-reported)

Usage:
  isa end [--passed] [options]

Options:
  --passed            the work passed (default: failed)
  --result <text>     one-line result note
  --artifact <path>   artifact path to record
  --home <path>       ISA home                 (default: $ISA_HOME or ./.isa)
  --repo <path>       working dir of the run   (default: cwd)
  --help, -h          show this help`;
}

export async function main(argv = process.argv.slice(2)) {
  const opt = { home: process.env.ISA_HOME || './.isa', repo: process.cwd(), passed: false, result: null, artifact: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage()); return; }
    else if (a === '--passed') opt.passed = true;
    else if (a === '--result') opt.result = argv[++i];
    else if (a === '--artifact') opt.artifact = argv[++i];
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else { console.error(`isa end: unknown option: ${a}`); process.exit(64); }
  }

  const engine = new Engine({ home: opt.home, repo: opt.repo });
  const r = engine.end({ passed: opt.passed, result: opt.result, artifact: opt.artifact });
  console.log(`${r.passed ? 'DONE' : 'FAIL'} ${r.id} — wall ${r.actuals.wall_ms}ms`);
  console.log(JSON.stringify(r.actuals, null, 2));
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
