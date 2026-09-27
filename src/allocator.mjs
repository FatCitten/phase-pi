/**
 * ISA-PRO — the ISA assembler.
 *
 * The ISA is a caveman language for AI context to flow in and out. The LLM is
 * the processor; its context window is memory; tokens are bytes; an ISA
 * instruction is the smallest unit of meaning worth spending tokens on.
 *
 * Two assemblers:
 *   heuristic — deterministic, offline. Budgets from the caller's ceilings,
 *     context halved (smallest context likely to finish). The fallback, not
 *     the product.
 *   model     — the LLM emits ROUTE / GRANT / ALLOC lines, streamed over an
 *     OpenAI-compatible endpoint. Every emitted value is clamped to the
 *     caller's ceilings. The clamp is the runtime disposing.
 *
 * Pure Node stdlib. No training, no state machine, no judgment — assembly in,
 * a validated allocation out.
 */
import { resolveProvider } from './provider.mjs';

export const RESOURCES = [
  ['CONTEXT_TOKENS', 'context_tokens'],
  ['TOKENS', 'tokens'],
  ['WALL_MS', 'wall_ms'],
  ['TOOL_CALLS', 'tool_calls'],
  ['MONEY_MICROUNITS', 'money_microunits'],
  ['HUMAN_ATTENTION_MICROUNITS', 'human_attention_microunits'],
];

export const DEFAULT_BUDGETS = Object.freeze({
  context_tokens: 32000,
  tokens: 32000,
  wall_ms: 15 * 60 * 1000,
  tool_calls: 48,
  money_microunits: 0,
  human_attention_microunits: 0,
});

/** The model's prompt. One rule per line, no priors, no theater. */
export const SYSTEM_PROMPT = [
  'You are an ISA assembler. You do not write project code and you do not invent project facts.',
  'Emit only ISA assembly — one instruction per line, nothing else.',
  'Instructions:',
  '  ROUTE <agent>          the agent that runs the task',
  '  GRANT <tool>           grant one tool (repeat the line for more)',
  '  ALLOC <RESOURCE> <n>   budget for a resource, never above the given ceiling',
  'Resources: CONTEXT_TOKENS, TOKENS, WALL_MS, TOOL_CALLS, MONEY_MICROUNITS, HUMAN_ATTENTION_MICROUNITS.',
  'No prose, no JSON, no markdown, no commentary.',
].join('\n');

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Parse ISA assembly text into a structured decision. GRANT is a set; ROUTE
 * and ALLOC are last-wins; `;` starts an inline comment. Throws when the text
 * contains no recognized instruction.
 */
export function parseISA(raw) {
  const d = { tools: [] };
  const granted = new Set();
  let recognized = 0;
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/;.*/, '').trim();
    if (!line) continue;
    const [op, ...args] = line.split(/\s+/);
    const kind = op?.toUpperCase();
    if (kind === 'ROUTE' && args[0]) { d.agent = args[0]; recognized++; continue; }
    if (kind === 'GRANT' && args[0]) {
      if (!granted.has(args[0])) { granted.add(args[0]); d.tools.push(args[0]); }
      recognized++;
      continue;
    }
    if (kind === 'ALLOC' && args[0]) {
      const n = Number(args[1]);
      if (!Number.isFinite(n)) continue;
      const key = RESOURCES.find(([tag]) => tag === args[0].toUpperCase())?.[1];
      if (key) { d[key] = n; recognized++; }
    }
  }
  if (!recognized) throw new Error('no ISA assembly found in model output');
  return d;
}

/**
 * If a model ignored the line format and answered in JSON, salvage the object.
 * The caveman format is the contract; this is a lenient last read, never a
 * preferred path.
 */
export function pickJson(raw) {
  const s = String(raw ?? '').trim();
  try { return JSON.parse(s); } catch { /* fall through to brace extraction */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('model output is neither ISA assembly nor JSON');
  return JSON.parse(m[0]);
}

/** Render an allocation back to ISA text. Deterministic, deduped, one line
 *  per decision. */
export function toISA(allocation) {
  const b = allocation.budget ?? {};
  const lines = [`ROUTE ${allocation.agent}`];
  for (const [tag, key] of RESOURCES) {
    const n = Number(b[key]);
    if (Number.isFinite(n)) lines.push(`ALLOC ${tag} ${Math.round(n)}`);
  }
  const granted = new Set();
  for (const tool of allocation.tools ?? []) {
    if (granted.has(tool)) continue; // a grant is a set
    granted.add(tool);
    lines.push(`GRANT ${tool}`);
  }
  return lines.join('\n');
}

/**
 * Merge a model decision over the heuristic base, clamped to the caller's
 * ceilings. Foreign agents and ungranted tools never survive; no emitted
 * value may exceed its ceiling; a non-positive ceiling forces zero.
 */
export function clampISA(base, decision, { allowedTools = null, allowedAgents = null } = {}) {
  const tools = new Set(allowedTools ?? base.tools ?? []);
  const agents = new Set(allowedAgents ?? [base.agent]);
  const agent = agents.has(String(decision.agent)) ? String(decision.agent) : base.agent;
  const granted = (Array.isArray(decision.tools) ? decision.tools : []).map(String).filter((t) => tools.has(t));
  const budget = {};
  for (const [, key] of RESOURCES) {
    const ceil = Number(base.budget?.[key]);
    if (!Number.isFinite(ceil) || ceil < 1) {
      budget[key] = Number.isFinite(ceil) ? Math.max(0, ceil) : 1;
      continue;
    }
    const v = Number(decision[key]);
    budget[key] = Math.round(clamp(Number.isFinite(v) ? v : ceil, 1, ceil));
  }
  return { ...base, agent, tools: granted.length ? granted : base.tools, budget, policy: 'model' };
}

/**
 * Deterministic offline allocation from the caller's ceilings. Context is
 * halved — smallest context likely to finish. No growth logic, no priors.
 */
export function heuristic(task) {
  const ceiling = task.budget ?? {};
  const budget = {};
  for (const [, key] of RESOURCES) {
    const c = Number(ceiling[key]);
    budget[key] = Number.isFinite(c) ? Math.max(0, Math.round(c)) : DEFAULT_BUDGETS[key];
  }
  budget.context_tokens = Math.max(0, Math.round(budget.context_tokens / 2));
  const agent = typeof task.agent === 'string' && task.agent !== 'auto' ? task.agent : 'auto';
  return {
    schema: 'isa-allocation-v1',
    agent,
    tools: Array.isArray(task.tools) ? task.tools.map(String) : [],
    budget,
    policy: 'heuristic',
  };
}

// --- SSE helpers (OpenAI-compatible stream) ---
// Keep reading `delta.content` only. Reasoning models stream a long
// `delta.reasoning` preamble before the final answer arrives in
// `delta.content`; consuming reasoning would corrupt ISA parsing.
function sseDelta(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data)?.choices?.[0]?.delta?.content ?? null; } catch { return null; }
}

async function streamRawResponse(res) {
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const delta = sseDelta(line);
      if (delta) full += delta;
    }
  }
  if (buffer.trim() && buffer.startsWith('data:')) {
    const delta = sseDelta(buffer);
    if (delta) full += delta;
  }
  return full;
}

async function modelDecision({ model, base_url, state, stream = true, maxRetries = 2, retryDelayMs = 400, retryBackoffFactor = 2, timeout_ms = 30000 }) {
  const attempts = Math.max(0, Math.round(Number(maxRetries))) + 1;
  const delay = Math.max(0, Number(retryDelayMs));
  const backoff = Math.max(1, Number(retryBackoffFactor));
  const timeout = Math.max(1, Number(timeout_ms));
  const url = `${String(base_url).replace(/\/+$/, '')}/chat/completions`;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(delay * Math.pow(backoff, attempt - 1), 10000)));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const body = {
        model: String(model),
        temperature: 0,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(state) },
        ],
      };
      if (stream) body.stream = true;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ISA_API_KEY ?? 'no-key'}` },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const status = r.status;
      if (status >= 500 || status === 429) { // transient upstream: retryable
        lastError = new Error(`isa model ${status}: ${await r.text()}`);
        if (attempt === attempts - 1) throw lastError;
        continue;
      }
      if (!r.ok) throw new Error(`isa model ${status}: ${await r.text()}`);
      const raw = stream ? await streamRawResponse(r) : (await r.json())?.choices?.[0]?.message?.content ?? '';
      try { return parseISA(raw); } catch { return pickJson(raw); }
    } catch (error) {
      if (error === lastError) throw error; // already rethrown when retries exhausted
      const transient =
        ctl.signal.aborted // timeout abort
        || error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.name === 'TypeError'
        || /^(?:fetch\s*failed|network|ECONN|ENOTFOUND|ETIMEDOUT|socket)/i.test(String(error?.message ?? ''));
      if (transient && attempt < attempts - 1) { lastError = error; continue; }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable in practice; keeps the exhaust path explicit for callers.
  throw lastError ?? new Error('isa model request exhausted retries');
}

export class ISAAllocator {
  constructor({ policy = 'heuristic', model = null } = {}) {
    this.policy = policy;
    this.model = model ?? {};
  }

  /**
   * Allocate a task. Task shape:
   *   { objective, cwd, agent?, tools?, budget? }  — budget is the ceilings.
   * Returns { schema, agent, tools, budget, policy, asm, model_decision? }.
   */
  async allocate(task) {
    const base = heuristic(task);
    if (this.policy !== 'model') {
      base.asm = toISA(base);
      return base;
    }
    const provider = resolveProvider();
    const allowedTools = new Set(task.tools ?? []);
    const allowedAgents = new Set([base.agent]);
    try {
      const decision = await modelDecision({
        model: this.model.model ?? provider.model,
        base_url: this.model.base_url ?? provider.base_url,
        stream: this.model.stream !== false,
        maxRetries: this.model.maxRetries ?? this.model.retries ?? 2,
        retryDelayMs: this.model.retryDelayMs,
        retryBackoffFactor: this.model.retryBackoffFactor,
        timeout_ms: this.model.timeout_ms,
        state: {
          objective: task.objective,
          ceilings: base.budget,
          allowed_agents: [...allowedAgents],
          allowed_tools: [...allowedTools],
        },
      });
      const out = clampISA(base, decision, { allowedTools, allowedAgents });
      out.model_decision = { action: 'allocate', raw: decision };
      out.asm = toISA(out);
      return out;
    } catch (error) {
      if (this.model.required) throw error;
      const out = { ...base, policy: 'heuristic-fallback', model_error: String(error?.message ?? error) };
      out.asm = toISA(out);
      return out;
    }
  }
}
