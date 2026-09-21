import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const arr = (x) => x == null ? [] : Array.isArray(x) ? x : [x];
const num = (x, fallback) => Number.isFinite(Number(x)) ? Number(x) : fallback;


export function normalizeWorkflow(raw, { baseDir = process.cwd() } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('workflow must be an object');
  const id = String(raw.id ?? `workflow-${randomUUID().slice(0,8)}`);
  const objective = String(raw.objective ?? raw.task ?? '').trim();
  if (!objective) throw new Error('workflow requires objective');
  const cwd = resolve(baseDir, raw.cwd ?? '.');
  const defaultAgent = raw.defaults?.agent ?? raw.agent ?? 'auto';
  const defaultBudget = {
    tokens: num(raw.defaults?.budget?.tokens, 24000),
    context_tokens: num(raw.defaults?.budget?.context_tokens, 12000),
    wall_ms: num(raw.defaults?.budget?.wall_ms, 15*60*1000),
    tool_calls: num(raw.defaults?.budget?.tool_calls, 40),
    money_microunits: num(raw.defaults?.budget?.money_microunits, 0),
    human_attention_microunits: num(raw.defaults?.budget?.human_attention_microunits, 0)
  };
  const fibers = arr(raw.fibers).map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`fiber ${i+1} must be an object`);
    const fid = String(f.id ?? `F${i+1}`);
    const objective = String(f.objective ?? f.task ?? '').trim();
    if (!objective) throw new Error(`fiber ${fid} requires objective`);
    return {
      id: fid,
      objective,
      depends_on: arr(f.depends_on).map(String),
      agent: f.agent ?? defaultAgent,
      tools: arr(f.tools ?? ['read','edit','test']).map(String),
      budget: { ...defaultBudget, ...(f.budget ?? {}) },
      validation: arr(f.validation).map((v) => Array.isArray(v) ? v.map(String) : String(v)),
      context: arr(f.context).map(String),
      human_gate: Boolean(f.human_gate),
      metadata: f.metadata ?? {}
    };
  });
  if (!fibers.length) fibers.push({ id:'F1', objective, depends_on:[], agent:defaultAgent, tools:['read','edit','test'], budget:defaultBudget, validation:[], context:[], human_gate:false, metadata:{} });
  const ids = new Set();
  for (const f of fibers) { if (ids.has(f.id)) throw new Error(`duplicate fiber id ${f.id}`); ids.add(f.id); }
  for (const f of fibers) for (const dep of f.depends_on) if (!ids.has(dep)) throw new Error(`fiber ${f.id} depends on missing ${dep}`);
  return {
    schema: 'phase-workflow-v1', id, objective, cwd,
    constraints: arr(raw.constraints).map(String),
    decisions: arr(raw.decisions).map(String),
    total_budget: raw.total_budget ?? null,
    defaults: { agent: defaultAgent, budget: defaultBudget },
    fibers,
    allocator: { policy: String(raw.allocator?.policy ?? 'heuristic'), base_url: String(raw.allocator?.base_url ?? 'http://127.0.0.1:8080/v1'), model: String(raw.allocator?.model ?? 'phase-tpm-allocator'), timeout_ms: num(raw.allocator?.timeout_ms, 30000), required: Boolean(raw.allocator?.required ?? false) },
    isolation: { enabled: raw.isolation?.enabled !== false, required: Boolean(raw.isolation?.required ?? false), read: arr(raw.isolation?.read).map(String), copy: arr(raw.isolation?.copy).map(String) },
    metadata: raw.metadata ?? {}
  };
}

