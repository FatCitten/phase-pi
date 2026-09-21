#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) server exposing Phase 2.0's allocator as a tool.
 *
 * Speaks JSON-RPC 2.0 over stdio (per the MCP spec). Any MCP-aware client
 * (Claude, Codex, Gemini, etc.) can register `phase_allocate` and ask Phase to
 * turn human intent into a bounded allocation plan (route/tools/budget).
 *
 * The SLM coordinates; the calling LLM does the work.
 *
 * Run:
 *   node src/mcp-server.mjs            # speak MCP over stdio
 *   MCP_PHASE=1 node src/mcp-server.mjs --ping   # smoke-test handshake
 */
import { PhaseAllocator } from './allocator.mjs';
import { normalizeWorkflow } from './phase-ir.mjs';
import { PHASE_ARCHITECTURE_SEED, seedHash } from './phase-seeds.mjs';
import { canonicalRepositoryPath, repositoryDomainId, gitSnapshot } from './util.mjs';
import { resolveProvider } from './provider.mjs';

const VERSION = '2.0.0';
const NAME = 'phase';
const PROTOCOL = '2024-11-05';

const TOOLS = [{
  name: 'phase_allocate',
  description: 'Turn human intent into a bounded Phase allocation plan. Calls the SLM (or heuristic fallback) to decide agent route, granted tools, and budget for a task in a repo. Returns a JSON plan plus the human-readable Phase ISA. Use this before executing a task so you work within the right budget and tool set.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Human intent / objective to allocate for.' },
      repo: { type: 'string', description: 'Absolute repo/git root. Defaults to cwd.' },
      policy: { type: 'string', enum: ['model', 'heuristic'], description: "model (SLM) or heuristic. Default model." },
      model: { type: 'string', description: 'SLM model id, e.g. qwen2.5:0.5b.' },
      base_url: { type: 'string', description: 'OpenAI-compatible chat-completions endpoint.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Allowed tools.' },
      budget: { type: 'object', description: 'Budget overrides.' },
      stream: { type: 'boolean', description: 'If true, emit progressive notifications/message events as the SLM allocates.' }
    },
    required: ['task']
  }
}];

function parseArgs(required) {
  const slm = resolveProvider({ prefix: 'SLM', fallbackModel: 'qwen2.5:1.5b' });
  return {
    ...required,
    repo: String(required.repo ?? process.cwd()),
    policy: String(required.policy ?? process.env.PHASE_SLM_POLICY ?? 'model').toLowerCase(),
    model: String(required.model ?? process.env.PHASE_SLM_MODEL ?? slm.model),
    base_url: String(required.base_url ?? process.env.PHASE_SLM_BASE_URL ?? slm.base_url),
    tools: Array.isArray(required.tools) && required.tools.length ? required.tools.map(String) : ['read', 'edit', 'test', 'bash'],
    budget: required.budget && typeof required.budget === 'object' ? required.budget : {}
  };
}

async function allocate(args, { stream = false, onToken = null } = {}) {
  const a = parseArgs(args);
  if (!a.task || !String(a.task).trim()) throw new Error('task is required');
  const cwd = canonicalRepositoryPath(a.repo);
  const policy = a.policy === 'h' || a.policy === 'heuristic' ? 'heuristic' : 'model';
  const rawWorkflow = {
    id: 'intent', objective: a.task, cwd,
    constraints: [], decisions: [],
    defaults: { agent: 'auto', budget: {
      tokens: a.budget.tokens ?? 24000, context_tokens: a.budget.context_tokens ?? 12000,
      wall_ms: a.budget.wall_ms ?? 900000, tool_calls: a.budget.tool_calls ?? 40,
      money_microunits: a.budget.money_microunits ?? 0, human_attention_microunits: a.budget.human_attention_microunits ?? 0
    } },
    fibers: [{ id: 'F1', objective: a.task, depends_on: [], agent: 'auto', tools: a.tools, budget: a.budget, validation: [] }],
    allocator: { policy, base_url: a.base_url, model: a.model, required: false }
  };
  const workflow = normalizeWorkflow(rawWorkflow, { baseDir: cwd });
  const allocator = new PhaseAllocator({ policy, model: { base_url: a.base_url, model: a.model, timeout_ms: 30000, ...(stream ? { stream: true, onToken } : {}) } });
  const allocation = await allocator.allocate({ workflow, fiber: workflow.fibers[0], runtime: {}, availableAgents: [] });
  const git = gitSnapshot(cwd);
  return {
    schema: 'phase-alloc-servant-v1',
    tool: 'phase',
    objective: a.task,
    repo: { root: cwd, domain_id: repositoryDomainId(cwd), commit: git.commit, dirty: git.dirty },
    seed_hash: seedHash(PHASE_ARCHITECTURE_SEED),
    allocation_policy: allocation.policy,
    model: { id: a.model, base_url: a.base_url },
    model_error: allocation.model_error ?? null,
    fiber: { id: workflow.fibers[0].id, objective: workflow.fibers[0].objective, tools: workflow.fibers[0].tools },
    allocation: { agent: allocation.agent, tools: allocation.tools, budget: allocation.budget, reserve: allocation.reserve, stop: allocation.stop },
    isa: allocation.asm
  };
}

// --- JSON-RPC 2.0 framing over stdio ---
function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return; // wait for full headers
      const header = buf.slice(0, headerEnd).toString();
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      const body = buf.subarray(headerEnd + 4);
      if (!m || body.length < Number(m[1])) return;
      const payload = body.subarray(0, Number(m[1])).toString();
      chunks.length = 0;
      try { resolve(JSON.parse(payload)); } catch (e) { reject(e); }
    });
    process.stdin.on('end', () => reject(new Error('stdin closed')));
  });
}
function sendMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
function rpcError(id, code, message) { sendMessage({ jsonrpc: '2.0', id, error: { code, message } }); }
function rpcResult(id, result) { sendMessage({ jsonrpc: '2.0', id, result }); }
function notif(method, params) { sendMessage({ jsonrpc: '2.0', method, params }); }

function handleRequest(req) {
  const { id, method, params = {} } = req;
  switch (method) {
    case 'initialize':
      rpcResult(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: NAME, version: VERSION } });
      return;
    case 'ping':
      rpcResult(id, {});
      return;
    case 'tools/list':
      rpcResult(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case 'tools/call': {
      const tool = String(params.name ?? '');
      const toolDef = TOOLS.find((t) => t.name === tool);
      if (!toolDef) return rpcError(id, -32602, `unknown tool: ${tool}`);
      const wantStream = Boolean(params.arguments?.stream);
      if (wantStream) {
        notif('notifications/message', { level: 'info', data: { type: 'phase.stream.start' } });
      }
      allocate(params.arguments ?? {}, {
        stream: wantStream,
        onToken: wantStream ? (t) => notif('notifications/message', { level: 'info', data: { type: 'phase.stream.token', token: t } }) : null
      }).then((result) => {
        if (wantStream) notif('notifications/message', { level: 'info', data: { type: 'phase.stream.end' } });
        rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
      }).catch((e) => {
        if (wantStream) notif('notifications/message', { level: 'info', data: { type: 'phase.stream.error', message: String(e.message || e) } });
        rpcError(id, -32603, String(e.message || e));
      });
      return Promise.resolve();
    }
    case 'notifications/initialized':
      return; // no response
    case 'notifications/cancelled':
      return;
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

async function run() {
  // Smoke test path
  if (process.argv.includes('--ping')) {
    const result = await allocate({ task: 'smoke test allocation', policy: 'heuristic', repo: process.cwd() });
    console.error(`MCP handshake OK -> allocated ${result.allocation_policy}; isa='${result.isa.split('\\n')[0]}'`);
    process.exit(0);
  }
  let pending = null;
  while (true) {
    try { pending = readMessage(); } catch (e) { process.exit(0); }
    const req = await pending;
    if (req) {
      if (req.jsonrpc !== '2.0' || req.method === undefined) {
        rpcError(req.id ?? null, -32600, 'Invalid Request');
        continue;
      }
      handleRequest(req);
    }
  }
}

export { allocate, handleRequest, TOOLS, NAME, VERSION, PROTOCOL };

if (process.argv[1]?.includes('mcp-server.mjs')) run();
