#!/usr/bin/env node
/**
 * isa-begin — start a run. The processor (session LLM) proposes; the engine
 * validates, clamps, logs, and opens the sandbox.
 *
 *   isa begin "add rate limiting"                    defaults from ceilings
 *   isa begin "..." --asm "ALLOC TOKENS 8000 ..."    the LLM's own assembly
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';

const SELF = fileURLToPath(import.meta.url);

export function usage() {
  return `isa begin — start a run (the processor proposes; the engine disposes)

Usage:
  isa begin <task> [options]

Options:
  --repo <path>        working dir the run coordinates        (default: cwd)
  --home <path>        ISA home                                (default: $ISA_HOME or <repo>/.isa)
  --asm <text>         the LLM's own ISA assembly (validated, clamped)
  --ceil K=V [...]     ceilings, e.g. --ceil TOKENS=8000 --ceil WALL_MS=60000
  --agent <name>       agent to ROUTE (default: auto)
  --tool <name>        grant a tool (repeatable; default read/edit/test/bash)
  --json               print the run record as JSON only
  --help, -h           show this help`;
}

function fail(msg, code = 64) {
  console.error(`isa begin: ${msg}`);
  process.exit(code);
}

export async function main(argv = process.argv.slice(2)) {
  const opt = { repo: process.cwd(), home: null, asm: null, agent: 'auto', tools: [], json: false, ceilings: {} };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage()); return; }
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--asm') opt.asm = argv[++i];
    else if (a === '--ceil') {
      const [k, v] = String(argv[++i]).split('=');
      if (k && v !== undefined) opt.ceilings[k.toLowerCase()] = v;
    }
    else if (a === '--agent') opt.agent = argv[++i];
    else if (a === '--tool') opt.tools.push(argv[++i]);
    else if (a === '--json') opt.json = true;
    else if (a.startsWith('-')) fail(`unknown option: ${a}`);
    else positionals.push(a);
  }
  const task = positionals.join(' ').trim();
  if (!task) { console.log(usage()); process.exit(64); }

  const home = opt.home ?? process.env.ISA_HOME ?? `${opt.repo}/.isa`;
  const engine = new Engine({ home, repo: opt.repo });
  const tools = opt.tools.length ? opt.tools : ['read', 'edit', 'test', 'bash'];
  const { id, alloc, sandbox } = engine.begin({ task, asm: opt.asm, ceilings: opt.ceilings, agent: opt.agent, tools });

  if (opt.json) {
    console.log(JSON.stringify({ id, task, alloc, sandbox }, null, 2));
  } else {
    console.log(`RUN ${id} — ${task}`);
    console.log(`sandbox: ${sandbox}`);
    console.log(`author: ${alloc.author} · agent: ${alloc.agent} · tools: ${alloc.tools.join(',')}`);
    console.log(`budget: ${JSON.stringify(alloc.budget)}`);
    console.log(`\nISA:\n${alloc.asm}`);
  }
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
