#!/usr/bin/env node
/**
 * phase — a servant tool that turns human intent into a Phase allocation plan
 * for an LLM agent to execute.
 *
 * The small language model (SLM) decides the agent route, granted tools, and
 * budgets. The calling LLM does the actual work using that allocation.
 *
 * Works as a CLI the LLM shells out to, or read via stdin. Point it at a repo
 * and it just works.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PhaseAllocator, allocationToAssembly } from '../src/allocator.mjs';
import { normalizeWorkflow } from '../src/phase-ir.mjs';
import { PHASE_ARCHITECTURE_SEED, seedHash } from '../src/phase-seeds.mjs';
import { canonicalRepositoryPath, repositoryDomainId, gitSnapshot } from '../src/util.mjs';
import { ADAPTERS, adapterById, adapterSummary, resolveAdapter } from '../src/adapters.mjs';
import { resolveProvider } from '../src/provider.mjs';

const USAGE = `phase — turn human intent into a Phase allocation plan an LLM agent can execute.

  phase <task-or-file> [options]
  echo "task" | phase - [options]

The SLM decides agent route, granted tools, and budget; the LLM does the work.

Arguments:
  <task-or-file>   quoted human-intent task string, "-" for stdin, or a path to a task file

Options:
  --repo <path>       repo/git root to coordinate        (default: cwd)
  --policy model|h    model (SLM) or heuristic           (default: model)
  --base-url <url>    OpenAI-compatible chat endpoint     (default: $PHASE_SLM_BASE_URL or pi's provider / Ollama 11434)
  --model <id>        SLM model id                        (default: $PHASE_SLM_MODEL or $PI_MODEL)
  --retries <n>       retries on transient SLM errors     (default: $PHASE_SLM_RETRIES or 2)
  --retry-delay <ms>  initial backoff delay between retries (default: $PHASE_SLM_RETRY_DELAY or 400)
  --retry-backoff <f> multiplicative backoff factor       (default: 2)
  --stream            stream SLM tokens live as they're generated
  --stream-isa        stream the ISA plan inline to stdout as it's generated
  --tools a,b,c       allowed tools                       (default: read,edit,test,bash)
  --budget.k=v        budget override, e.g. --budget.wall_ms=120000
  --adapter <id>      build a harness tool call (pi|codex|claude|gemini)
  --adapters          list available harness adapters
  --isa               print only the human-readable Phase ISA plan
  --json              print the full plan as JSON         (default)
  --help, -h          show this help

Examples:
  phase "fix the failing auth tests" --repo .          # uses $PI_MODEL / the chat model by default
  echo "add rate limiting to the API" | phase - --repo .
  phase task.md --policy heuristic --isa
`;

function fail(message, code = 64) { console.error(`phase: ${message}`); process.exitCode = code; }

function defaultProvider() {
  const { base_url, model } = resolveProvider({ prefix: 'SLM', fallbackModel: 'qwen2.5:1.5b' });
  return { baseUrl: base_url, model };
}

function parseArgs(argv) {
  const def = defaultProvider();
  const opt = { repo: process.cwd(), policy: process.env.PHASE_SLM_POLICY ?? 'model', baseUrl: process.env.PHASE_SLM_BASE_URL ?? def.baseUrl, model: process.env.PHASE_SLM_MODEL ?? def.model, retries: process.env.PHASE_SLM_RETRIES ?? 2, retryDelay: process.env.PHASE_SLM_RETRY_DELAY ?? 400, retryBackoff: 2, stream: !!process.env.PHASE_SLM_STREAM, streamIsa: false, tools: null, budget: {}, isa: false, json: true, task: null, file: null, adapter: null, listAdapters: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--isa') { opt.isa = true; opt.json = false; }
    else if (a === '--json') { opt.json = true; opt.isa = false; }
    else if (a === '--adapters') { opt.listAdapters = true; }
    else if (a === '--adapter') { opt.adapter = argv[++i]; if (opt.adapter == null) fail('--adapter requires an id'); }
    else if (a === '--repo') { opt.repo = argv[++i]; if (opt.repo == null) fail('--repo requires a path'); }
    else if (a === '--policy') { opt.policy = String(argv[++i] ?? '').toLowerCase(); }
    else if (a === '--base-url' || a === '--base_url') { opt.baseUrl = argv[++i]; }
    else if (a === '--retries') { opt.retries = Number(argv[++i]); if (opt.retries == null || Number.isNaN(opt.retries)) fail('--retries requires a number'); }
    else if (a === '--retry-delay' || a === '--retry_delay') { opt.retryDelay = Number(argv[++i]); if (opt.retryDelay == null || Number.isNaN(opt.retryDelay)) fail('--retry-delay requires a number'); }
    else if (a === '--retry-backoff') { opt.retryBackoff = Number(argv[++i]); if (opt.retryBackoff == null || Number.isNaN(opt.retryBackoff)) fail('--retry-backoff requires a number'); }
    else if (a === '--stream') { opt.stream = true; }
    else if (a === '--stream-isa') { opt.stream = true; opt.streamIsa = true; opt.isa = true; opt.json = false; }
    else if (a === '--model') { opt.model = argv[++i]; }
    else if (a === '--tools') { opt.tools = String(argv[++i] ?? '').split(',').map((x) => x.trim()).filter(Boolean); }
    else if (a.startsWith('--budget.')) { const kv = a.slice('--budget.'.length).split('='); if (kv[1] != null) opt.budget[kv[0]] = Number(kv[1]); }
    else if (a.startsWith('-') && a !== '-') fail(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length < 1) fail('missing task (see --help)');
  opt.task = positional.join(' ');
  if (positional[0] === '-' && positional.length === 1) opt.stdin = true;
  else if (existsSync(resolve(opt.repo, positional[0])) && !positional[0].includes(' ')) opt.file = resolve(opt.repo, positional[0]);
  return opt;
}

async function readIntent(opt) {
  if (opt.stdin) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return { task: Buffer.concat(chunks).toString('utf8').trim(), kind: 'stdin' };
  }
  if (opt.file) return { task: readFileSync(opt.file, 'utf8').trim(), kind: 'file', file: opt.file };
  return { task: opt.task, kind: 'arg' };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = parseArgs(argv);
  if (process.exitCode) return;

  if (opt.listAdapters) {
    console.log(JSON.stringify(ADAPTERS.map(({ id, label, notes }) => ({ id, label, notes })), null, 2));
    return;
  }

  const cwd = resolve(opt.repo);
  const intent = await readIntent(opt);
  if (!intent.task) fail('empty task');

  const tools = opt.tools ?? ['read', 'edit', 'test', 'bash'];
  const rawWorkflow = {
    id: 'intent',
    objective: intent.task,
    cwd,
    constraints: [],
    decisions: [],
    defaults: { agent: 'auto', budget: {
      tokens: 24000, context_tokens: 12000, wall_ms: 15 * 60 * 1000, tool_calls: 40,
      money_microunits: 0, human_attention_microunits: 0, ...opt.budget
    } },
    fibers: [{ id: 'F1', objective: intent.task, depends_on: [], agent: 'auto', tools, budget: { ...opt.budget }, validation: [] }],
    allocator: { policy: opt.policy === 'h' || opt.policy === 'heuristic' ? 'heuristic' : 'model', base_url: opt.baseUrl, model: opt.model, required: false, maxRetries: opt.retries, retryDelayMs: opt.retryDelay, retryBackoffFactor: opt.retryBackoff }
  };

  const workflow = normalizeWorkflow(rawWorkflow, { baseDir: cwd });
  const fiber = workflow.fibers[0];

  const allocator = new PhaseAllocator({ policy: workflow.allocator.policy, model: { base_url: workflow.allocator.base_url, model: workflow.allocator.model, timeout_ms: workflow.allocator.timeout_ms, maxRetries: workflow.allocator.maxRetries, retryDelayMs: workflow.allocator.retryDelayMs, retryBackoffFactor: workflow.allocator.retryBackoffFactor, stream: opt.stream, onToken: opt.stream ? (t) => { if (opt.streamIsa) process.stdout.write(t); else process.stderr.write(t); } : null } });
  if (opt.streamIsa) process.stdout.write('; streaming allocation...\n');
  const allocation = await allocator.allocate({ workflow, fiber, runtime: {}, availableAgents: [] });
  if (opt.stream) process.stderr.write('\n'); // terminate streamed SLM output
  if (opt.streamIsa && allocation.policy === 'heuristic-fallback') process.stdout.write(`; (SLM unavailable; heuristic fallback: ${allocation.model_error})\n`);

  const git = gitSnapshot(cwd);
  const plan = {
    schema: 'phase-alloc-servant-v1',
    tool: 'phase',
    objective: intent.task,
    intent_source: intent.kind,
    repo: { root: canonicalRepositoryPath(cwd), domain_id: repositoryDomainId(cwd), commit: git.commit, dirty: git.dirty },
    seed_hash: seedHash(PHASE_ARCHITECTURE_SEED),
    allocation_policy: allocation.policy,
    model: { id: workflow.allocator.model, base_url: workflow.allocator.base_url },
    model_error: allocation.model_error ?? null,
    fiber: { id: fiber.id, objective: fiber.objective, tools: fiber.tools },
    allocation: {
      agent: allocation.agent,
      tools: allocation.tools,
      budget: allocation.budget,
      reserve: allocation.reserve,
      stop: allocation.stop
    },
    isa: allocation.asm
  };

  if (opt.adapter) {
    const adapter = adapterById(opt.adapter) ?? resolveAdapter({ repo: cwd });
    if (!adapterById(opt.adapter)) console.error(`phase: unknown adapter '${opt.adapter}'; using ${adapter.id}`);
    const summary = adapterSummary(adapter, { task: intent.task, repo: cwd, model: workflow.allocator.model });
    plan.harness = { adapter: adapter.id, label: adapter.label, invoke: summary.invoke };
    if (opt.isa) console.log(summary.invoke);
    else console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (opt.isa) {
    if (!opt.streamIsa) {
      console.log(`; phase allocation for: ${intent.task}`);
      console.log(allocation.asm);
      console.log(`; policy=${allocation.policy}${allocation.policy !== 'heuristic' ? '' : ''}`);
    } else {
      process.stdout.write('\n');
    }
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }
}

main().catch((e) => fail(e.stack || e.message, 1));
