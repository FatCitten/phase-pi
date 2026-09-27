#!/usr/bin/env node
/**
 * isa-alloc — turn a task into an ISA allocation.
 *
 *   isa-alloc "add rate limiting"               heuristic (offline)
 *   isa-alloc "add rate limiting" --policy model
 *
 * Prints the allocation JSON (and, unless --json, the ISA text). Unless
 * --no-bus, logs the decision on the control bus and the ISA on the data bus,
 * so every emit is replayable.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BUDGETS, ISAAllocator } from '../src/allocator.mjs';
import { BusStore } from '../src/bus.mjs';
import { resolveProvider } from '../src/provider.mjs';

const SELF = fileURLToPath(import.meta.url);

export function usage() {
  const p = resolveProvider();
  return `isa-alloc — task -> ISA allocation

Usage:
  isa-alloc <task> [options]

Options:
  --repo <path>      working dir for the allocation      (default: cwd)
  --policy <p>       heuristic | model                   (default: heuristic)
  --model <id>       ISA model id                        (default: $ISA_MODEL or ${p.model})
  --base-url <url>   OpenAI-compatible endpoint          (default: $ISA_BASE_URL or ${p.base_url})
  --json             print allocation JSON only
  --home <path>      bus home                            (default: $ISA_HOME or ./.isa)
  --no-bus           do not write bus events
  --help, -h         show this help`;
}

function fail(msg, code = 64) {
  console.error(`isa-alloc: ${msg}`);
  process.exit(code);
}

export async function main(argv = process.argv.slice(2)) {
  const opt = {
    repo: process.cwd(),
    policy: 'heuristic',
    model: null,
    base_url: null,
    json: false,
    home: process.env.ISA_HOME || './.isa',
    noBus: false,
  };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage()); return; }
    else if (a === '--repo') opt.repo = resolve(argv[++i]);
    else if (a === '--policy') opt.policy = argv[++i];
    else if (a === '--model') opt.model = argv[++i];
    else if (a === '--base-url') opt.base_url = argv[++i];
    else if (a === '--json') opt.json = true;
    else if (a === '--home') opt.home = argv[++i];
    else if (a === '--no-bus') opt.noBus = true;
    else if (a.startsWith('-')) fail(`unknown option: ${a}`);
    else positionals.push(a);
  }
  const task = positionals.join(' ').trim();
  if (!task) { console.log(usage()); process.exit(64); }

  const provider = resolveProvider({ model: opt.model ?? undefined, base_url: opt.base_url ?? undefined });
  const allocator = new ISAAllocator({
    policy: opt.policy,
    model: { model: provider.model, base_url: provider.base_url },
  });
  const allocation = await allocator.allocate({
    objective: task,
    cwd: opt.repo,
    tools: ['read', 'edit', 'test', 'bash'],
    budget: { ...DEFAULT_BUDGETS },
  });

  process.stdout.write(JSON.stringify(allocation, null, 2) + '\n');
  if (!opt.json) process.stdout.write(`\nISA:\n${allocation.asm}\n`);

  if (!opt.noBus) {
    const bus = new BusStore({ home: opt.home, repo: opt.repo });
    bus.emit('control', 'alloc.decision', {
      objective: task,
      policy: allocation.policy,
      agent: allocation.agent,
      tools: allocation.tools,
      budget: allocation.budget,
    });
    bus.emit('data', 'alloc.isa', { objective: task, isa: allocation.asm });
  }
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SELF); } catch { return false; }
}

if (invokedDirectly()) main().catch((e) => { console.error(e); process.exit(1); });
