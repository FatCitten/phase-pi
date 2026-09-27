#!/usr/bin/env node
/**
 * isa-begin — start a run. Nothing is planned: the run is a sandbox plus a
 * record. The bus logs what happens; nothing is committed up front.
 *
 *   isa begin "add rate limiting"
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';

const SELF = fileURLToPath(import.meta.url);

export function usage() {
  return `isa begin — start a run (a sandbox plus a record, nothing planned)

Usage:
  isa begin <task> [options]

Options:
  --repo <path>      working dir of the run   (default: cwd)
  --home <path>      ISA home                 (default: $ISA_HOME or <repo>/.isa)
  --json             print the run record as JSON only
  --help, -h         show this help`;
}

export async function main(argv = process.argv.slice(2)) {
  const opt = { repo: process.cwd(), home: null, json: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage()); return; }
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--json') opt.json = true;
    else if (a.startsWith('-')) { console.error(`isa begin: unknown option: ${a}`); process.exit(64); }
    else positionals.push(a);
  }
  const task = positionals.join(' ').trim();
  if (!task) { console.log(usage()); process.exit(64); }

  const home = opt.home ?? process.env.ISA_HOME ?? `${opt.repo}/.isa`;
  const engine = new Engine({ home, repo: opt.repo });
  const { id, sandbox } = engine.begin({ task });

  if (opt.json) {
    console.log(JSON.stringify({ id, task, sandbox }, null, 2));
  } else {
    console.log(`RUN ${id} — ${task}`);
    console.log(`sandbox: ${sandbox}`);
  }
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
