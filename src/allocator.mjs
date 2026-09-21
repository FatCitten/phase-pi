import { PHASE_ARCHITECTURE_SEED, seedHash, seedSystemPrompt } from './phase-seeds.mjs';
import { encodeAllocationState } from './phase-features.mjs';
import { resolveProvider } from './provider.mjs';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pickJson = (raw) => {
  const s = String(raw ?? '').trim();
  try { return JSON.parse(s); } catch { /* fall through to brace extraction */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('allocator model returned no JSON object');
  return JSON.parse(m[0]);
};

const RESOURCES = [
  ['CONTEXT_TOKENS', 'context_tokens'], ['TOKENS', 'tokens'],
  ['WALL_MS', 'wall_ms'], ['TOOL_CALLS', 'tool_calls'],
  ['MONEY_MICROUNITS', 'money_microunits'], ['HUMAN_ATTENTION_MICROUNITS', 'human_attention_microunits']
];

/**
 * Parse raw Phase ISA assembly emitted by the SLM into a structured decision.
 *
 * Runs a dedup pass: GRANTs are collected as a set (the SLM is prone to repeating
 * them) and duplicate ROUTE/ALLOC lines are last-wins. Set semantics keep the ISA
 * clean and the downstream allocation noise-free.
 */
export function parseAllocatorAssembly(raw) {
  const d = { tools: [] };
  const granted = new Set();
  let recognized = 0;
  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/;.*/, '').trim();
    if (!line) continue;
    const [op, ...args] = line.split(/\s+/);
    const kind = op?.toUpperCase();
    if (kind === 'ROUTE' && args[0]) { d.agent = args[0]; recognized++; continue; }
    if (kind === 'GRANT' && args[0]) { if (!granted.has(args[0])) { granted.add(args[0]); d.tools.push(args[0]); } recognized++; continue; }
    if (kind === 'ALLOC' && args.length >= 1) {
      const n = Number(args[1]);
      if (!Number.isFinite(n)) continue;
      const key = RESOURCES.find(([tag]) => tag === args[0].toUpperCase())?.[1];
      if (key) { d[key] = n; recognized++; }
      continue;
    }
  }
  if (!recognized) throw new Error('allocator model returned no Phase assembly');
  d.action = 'allocate';
  d.asm = String(raw ?? '').trim();
  return d;
}

// Extract a content delta from an SSE `data:` line, or null if none/end-of-stream.
// NOTE: keep reading `delta.content` only. Reasoning/thinking models (e.g.
// deepseek-v4-flash) stream their *final answer* in `delta.content` *after* a long
// `delta.reasoning` preamble; consuming `reasoning` here would corrupt structured
// ISA parsing. The fix for empty content on such models is a larger max_tokens so
// the model gets past the reasoning pass and actually emits content.
function sseDelta(line) {
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data)?.choices?.[0]?.delta?.content ?? null;
  } catch {
    return null;
  }
}

// Read an OpenAI-compatible SSE stream (stream:true) from res.body, emitting each
// content token to onToken as it arrives, and returning the fully accumulated raw text.
async function streamRawResponse(res, onToken) {
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
      if (delta) { full += delta; if (onToken) onToken(delta); }
    }
  }
  // Flush any trailing complete event that arrived without a trailing newline.
  if (buffer.trim() && buffer.startsWith('data:')) {
    const delta = sseDelta(buffer);
    if (delta) { full += delta; if (onToken) onToken(delta); }
  }
  return full;
}

async function modelDecision({ config, state, seed }) {
  const stream = !!config.stream;
  const onToken = typeof config.onToken === 'function' ? config.onToken : null;
  const maxRetries = Math.max(0, Math.round(Number(config.maxRetries ?? config.retries ?? 2)));
  const baseDelay = Math.max(0, Number(config.retryDelayMs ?? 400));
  const backoffFactor = Math.max(1, Number(config.retryBackoffFactor ?? 2));
  const attempts = maxRetries + 1;
  const provider = resolveProvider({ prefix: 'SLM', fallbackModel: 'qwen2.5:1.5b' });
  const url = `${String(config.base_url ?? provider.base_url).replace(/\/$/, '')}/chat/completions`;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(baseDelay * Math.pow(backoffFactor, attempt - 1), 10000)));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(config.timeout_ms ?? 30000));
    try {
      const body = {
        model: String(config.model ?? provider.model),
        temperature: 0, max_tokens: 2048,
        messages: [
          { role: 'system', content: seedSystemPrompt(seed) },
          { role: 'user', content: JSON.stringify(state) }
        ]
      };
      if (stream) body.stream = true;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PHASE_ALLOCATOR_API_KEY ?? 'no-key'}` },
        body: JSON.stringify(body), signal: ctl.signal
      });
      const status = r.status;
      if (status >= 500 || status === 429) { // transient upstream: retryable
        lastError = new Error(`allocator model ${status}: ${await r.text()}`);
        if (attempt === attempts - 1) throw lastError;
        continue;
      }
      if (!r.ok) throw new Error(`allocator model ${status}: ${await r.text()}`); // 4xx: no retry
      const raw = stream ? await streamRawResponse(r, onToken) : (await r.json())?.choices?.[0]?.message?.content ?? '';
      try { return parseAllocatorAssembly(raw); } catch { return pickJson(raw); }
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
  throw lastError ?? new Error('allocator model request exhausted retries');
}

export function allocationToAssembly(allocation) {
  const b = allocation.budget ?? {};
  const lines = [`ROUTE ${allocation.agent}`];
  for (const [tag, key] of RESOURCES) {
    if (Number.isFinite(Number(b[key]))) lines.push(`ALLOC ${tag} ${Math.round(Number(b[key]))}`);
  }
  const granted = new Set();
  for (const tool of allocation.tools ?? []) {
    if (granted.has(tool)) continue; // dedup: never emit a GRANT twice
    granted.add(tool);
    lines.push(`GRANT ${tool}`);
  }
  return lines.join('\n');
}

export class PhaseAllocator {
  constructor({ seed = PHASE_ARCHITECTURE_SEED, policy = 'heuristic', model = null } = {}) {
    this.seed = seed;
    this.seedHash = seedHash(seed);
    this.policy = policy;
    this.model = model ?? {};
  }

  // Deterministic, offline allocation. The budget is clamped to a fraction of the
  // fiber ceiling, grown only by measured validation failures / context misses.
  heuristic({ workflow, fiber, runtime = {}, availableAgents = [] }) {
    const b = fiber.budget;
    const failures = Number(runtime.validation_failures ?? 0);
    const misses = Number(runtime.context_misses ?? 0);
    const growth = clamp(1 + failures * 0.25 + misses * 0.15, 1, 1.8);
    const context = Math.round(Math.min(Number(b.context_tokens), Number(b.context_tokens) * this.seed.priors.initial_context_fraction * growth));
    const agentSpec = fiber.agent;
    const requested = typeof agentSpec === 'string' ? agentSpec : String(agentSpec?.id ?? agentSpec?.adapter ?? 'exec');
    const agent = requested === 'auto' ? (availableAgents.find((x) => x.available)?.id ?? 'auto') : requested;
    const allocation = {
      schema: 'phase-allocation-v1',
      fiber_id: fiber.id,
      agent,
      agent_spec: typeof agentSpec === 'object' ? agentSpec : null,
      tools: [...fiber.tools],
      budget: { ...b, context_tokens: context },
      reserve: { fraction: this.seed.priors.reserve_fraction, repair_fraction: this.seed.priors.repair_reserve_fraction },
      stop: { on_validation_pass: true, max_wall_ms: Number(b.wall_ms), max_tool_calls: Number(b.tool_calls) },
      state_vector: encodeAllocationState({ workflow, fiber, runtime }),
      seed_hash: this.seedHash,
      policy: 'heuristic'
    };
    allocation.asm = allocationToAssembly(allocation);
    return allocation;
  }

  async allocate(args) {
    const base = this.heuristic(args);
    if (this.policy !== 'model') return base;
    const { fiber, availableAgents = [] } = args;
    const allowedAgents = new Set([base.agent, ...availableAgents.filter((x) => x.available).map((x) => x.id)]);
    try {
      const decision = await modelDecision({
        config: this.model, seed: this.seed,
        state: { state_vector: base.state_vector, budget_ceiling: fiber.budget, allowed_agents: [...allowedAgents], allowed_tools: fiber.tools, seed_hash: this.seedHash }
      });
      const agent = allowedAgents.has(String(decision.agent)) ? String(decision.agent) : base.agent;
      const allowedTools = new Set(fiber.tools);
      const tools = (Array.isArray(decision.tools) ? decision.tools : base.tools).map(String).filter((t) => allowedTools.has(t));
      const b = fiber.budget;
      const budget = {
        ...base.budget,
        context_tokens: Math.round(clamp(Number(decision.context_tokens ?? base.budget.context_tokens), 1, Number(b.context_tokens))),
        tokens: Math.round(clamp(Number(decision.tokens ?? base.budget.tokens), 1, Number(b.tokens))),
        wall_ms: Math.round(clamp(Number(decision.wall_ms ?? base.budget.wall_ms), 1000, Number(b.wall_ms))),
        tool_calls: Math.round(clamp(Number(decision.tool_calls ?? base.budget.tool_calls), 1, Number(b.tool_calls))),
        money_microunits: Math.round(clamp(Number(decision.money_microunits ?? base.budget.money_microunits), 0, Number(b.money_microunits))),
        human_attention_microunits: Math.round(clamp(Number(decision.human_attention_microunits ?? base.budget.human_attention_microunits), 0, Number(b.human_attention_microunits)))
      };
      const retries = Math.max(0, Math.round(Number(this.model.maxRetries ?? this.model.retries ?? 2)));
      const out = { ...base, agent, tools: tools.length ? tools : base.tools, budget, policy: 'model', model_decision: { action: String(decision.action ?? 'allocate'), raw: decision, retries } };
      out.asm = allocationToAssembly(out);
      return out;
    } catch (error) {
      if (this.model.required) throw error;
      return { ...base, policy: 'heuristic-fallback', model_error: String(error) };
    }
  }
}
