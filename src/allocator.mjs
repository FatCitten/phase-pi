/**
 * ISA-PRO — the ISA.
 *
 * The ISA is a caveman language for AI context to flow in and out. The LLM is
 * the processor — the model in the live session writes the assembly itself.
 * There is no SLM, no side endpoint: the runtime never calls an LLM.
 *
 * This module is the language only:
 *   parseISA         — assembly text -> structured decision
 *   toISA            — allocation -> assembly text (round-trip, deduped)
 *   defaults         — the allocation the ceilings imply when the LLM writes
 *                      nothing (offline fallback, context halved)
 *   allocateFromAsm  — validate the LLM's own assembly over the defaults,
 *                      bounded by the caller's ceilings. The clamp is the
 *                      runtime disposing.
 *
 * Pure Node stdlib. No training, no state machine, no judgment.
 */

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
  if (!recognized) throw new Error('no ISA assembly found');
  return d;
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
 * Merge a decision over the defaults, clamped to the caller's ceilings.
 * Foreign agents and ungranted tools never survive; no emitted value may
 * exceed its ceiling; a non-positive ceiling forces zero.
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
  return { ...base, agent, tools: granted.length ? granted : base.tools, budget };
}

/**
 * Deterministic offline defaults from the caller's ceilings. Context is
 * halved — smallest context likely to finish. No growth logic, no priors.
 */
export function defaults(task) {
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
  };
}

/**
 * The session LLM wrote assembly; the runtime validates it. No asm -> the
 * ceilings' defaults. `author` records who shaped the allocation.
 */
export function allocateFromAsm(task, asm = null) {
  const base = defaults(task);
  if (!asm) {
    return { ...base, author: 'defaults', asm: toISA(base) };
  }
  const decision = parseISA(asm);
  const allowedTools = new Set(task.tools ?? []);
  const allowedAgents = new Set([base.agent]);
  const out = clampISA(base, decision, { allowedTools, allowedAgents });
  return { ...out, author: 'session', asm: toISA(out) };
}
