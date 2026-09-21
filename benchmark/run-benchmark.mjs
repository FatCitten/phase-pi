#!/usr/bin/env node
/**
 * Benchmark harness for the phase allocator.
 *
 * Runs the real shipped CLI (bin/phase-alloc.mjs) end-to-end across a corpus of
 * representative tasks under several allocation configurations, captures each
 * full JSON plan plus wall-clock measurement, validates plan structure/safety,
 * and emits a research dataset (JSONL) + a metrics report (markdown).
 *
 * Configurations under test:
 *   model-live    policy=model  base_url=Ollama :11434 (live SLM, qwen2.5:0.5b)
 *   heuristic     policy=heuristic (deterministic, offline)
 *   fallback-down policy=model  base_url=:8080   (unreachable SLM -> heuristic fallback)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'phase-alloc.mjs');
const DATA_DIR = join(ROOT, 'benchmark', 'data');
const RAW_DIR = join(DATA_DIR, 'raw');
const REPO = ROOT; // benchmark runs "against" the phase repo itself

const ALLOWED_TOOLS = new Set(['read', 'edit', 'test', 'bash']);
const CEILING = { tokens: 24000, context_tokens: 12000, wall_ms: 900000, tool_calls: 40, money_microunits: 0, human_attention_microunits: 0 };

const corpus = JSON.parse(readFileSync(join(ROOT, 'benchmark', 'corpus.json'), 'utf8'));

const CONFIGS = [
  { id: 'model-live', policy: 'model', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:0.5b' },
  { id: 'heuristic', policy: 'heuristic', base_url: 'http://127.0.0.1:8080/v1', model: 'qwen2.5:0.5b' },
  { id: 'fallback-down', policy: 'model', base_url: 'http://127.0.0.1:8080/v1', model: 'qwen2.5:0.5b' },
];

function runOne({ taskId, objective, config, repeat = 0 }) {
  const argv = [BIN, objective, '--repo', REPO, '--policy', config.policy,
    '--base-url', config.base_url, '--model', config.model, '--retries', '0', '--json'];
  const start = process.hrtime.bigint();
  const r = spawnSync('node', argv, { encoding: 'utf8', timeout: 120000 });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  let plan = null, parseError = null;
  if (r.status === 0 && r.stdout) {
    try { plan = JSON.parse(r.stdout); } catch (e) { parseError = e.message; }
  }
  const stderr = (r.stderr || '').slice(0, 400);
  return {
    run_id: `${taskId}::${config.id}${repeat ? `::rep${repeat}` : ''}`,
    task_id: taskId, config_id: config.id, repeat,
    objective, policy_requested: config.policy,
    exit_code: r.status, elapsed_ms: elapsedMs, stderr,
    plan, parse_error: parseError
  };
}

// --- validation ------------------------------------------------------------
function validate(plan, run) {
  const V = { valid: false, checks: {} };
  const chk = (name, ok, detail) => { V.checks[name] = { ok: Boolean(ok), detail: detail ?? null }; };
  if (!plan) { V.checks.plan = { ok: false, detail: run.parse_error ?? run.stderr }; V.summary = 'no-plan'; return V; }
  chk('schema', plan.schema === 'phase-alloc-servant-v1', plan.schema);
  chk('has-allocation', !!plan.allocation);
  chk('has-isa', typeof plan.isa === 'string' && plan.isa.trim().length > 0, (plan.isa || '').length);
  chk('has-seed-hash', typeof plan.seed_hash === 'string' && plan.seed_hash.length === 64);
  chk('has-repo', !!plan.repo && !!plan.repo.domain_id && !!plan.repo.commit);
  chk('policy-declared', ['model', 'heuristic', 'heuristic-fallback'].includes(plan.allocation_policy), plan.allocation_policy);
  // model_error must be non-null exactly when the SLM-path fell back to the heuristic
  chk('model-error-consistent', (plan.allocation_policy === 'heuristic-fallback') === (plan.model_error != null), `policy=${plan.allocation_policy} err=${plan.model_error}`);
  const a = plan.allocation;
  // tools subset of allowed
  chk('tools-within-allowed', Array.isArray(a.tools) && a.tools.every((t) => ALLOWED_TOOLS.has(t)), JSON.stringify(a.tools));
  chk('agent-nonempty', typeof a.agent === 'string' && a.agent.length > 0, a.agent);
  // budget present & in ceiling
  const b = a.budget || {};
  chk('budget-fields', ['tokens','context_tokens','wall_ms','tool_calls','money_microunits','human_attention_microunits'].every((k) => Number.isFinite(Number(b[k]))));
  const inCeil = (k, lo) => { const v = Number(b[k]); return Number.isFinite(v) && v >= lo && v <= CEILING[k]; };
  chk('clamp-tokens', inCeil('tokens', 1), b.tokens);
  chk('clamp-context', inCeil('context_tokens', 1), b.context_tokens);
  chk('clamp-wall_ms', inCeil('wall_ms', 1000), b.wall_ms);
  chk('clamp-tool_calls', inCeil('tool_calls', 1), b.tool_calls);
  chk('clamp-money', inCeil('money_microunits', 0), b.money_microunits);
  chk('clamp-human', inCeil('human_attention_microunits', 0), b.human_attention_microunits);
  // ISA internal consistency
  const isa = plan.isa || '';
  const isaLines = isa.split(/\n/).map((l) => l.replace(/;.*/, '').trim()).filter(Boolean);
  const badLine = isaLines.find((l) => !/^(ROUTE|ALLOC|GRANT)\s/.test(l));
  chk('isa-instructions-only', !badLine, badLine ?? isaLines.length);
  chk('isa-route-matches-agent', isaLines.some((l) => l === `ROUTE ${a.agent}`), a.agent);
  const grantTools = isaLines.filter((l) => l.startsWith('GRANT')).map((l) => l.split(/\s+/)[1]);
  chk('isa-grants-match-tools', JSON.stringify([...grantTools].sort()) === JSON.stringify([...a.tools].sort()), JSON.stringify(grantTools));
  V.valid = Object.values(V.checks).every((c) => c.ok);
  V.summary = V.valid ? 'valid' : 'invalid';
  return V;
}

// --- run all ---------------------------------------------------------------
const rows = [];
for (const task of corpus) {
  for (const cfg of CONFIGS) {
    const run = runOne({ taskId: task.id, objective: task.objective, config: cfg });
    run.validation = validate(run.plan, run);
    rows.push(run);
    // repeat to observe SLM variability on a couple of tasks
    if (cfg.id === 'model-live' && (task.id === 'bugfix-auth' || task.id === 'perf-migrate' || task.id === 'docs-quickstart')) {
      const rep = runOne({ taskId: task.id, objective: task.objective, config: cfg, repeat: 1 });
      rep.validation = validate(rep.plan, rep);
      rows.push(rep);
    }
  }
}

// determinism: heuristic should produce byte-identical plans for same task
const heurRuns = rows.filter((r) => r.config_id === 'heuristic');
const heurDup = new Map();
for (const r of heurRuns) heurDup.set(r.task_id, (heurDup.get(r.task_id) || 0) + 1);
// all heuristic runs are unique per task (no repeats scheduled), so determinism
// is checked by re-running: recompute a duplicate for two tasks and compare.
const heurDeterministic = {};
for (const taskId of ['bugfix-auth', 'security-patch']) {
  const first = heurRuns.find((r) => r.task_id === taskId);
  const second = runOne({ taskId, objective: first.objective, config: CONFIGS[1] });
  second.validation = validate(second.plan, second);
  const identical = first.plan && second.plan
    && JSON.stringify(first.plan.allocation) === JSON.stringify(second.plan.allocation)
    && first.plan.isa === second.plan.isa;
  heurDeterministic[taskId] = identical;
  rows.push(second);
}

// --- persistence -----------------------------------------------------------
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(RAW_DIR, { recursive: true });
for (const r of rows) {
  if (r.plan) writeFileSync(join(RAW_DIR, `${r.run_id}.json`), JSON.stringify(r.plan, null, 2) + '\n');
}

const datasetPath = join(DATA_DIR, 'dataset.jsonl');
let fd = '';
for (const r of rows) fd += JSON.stringify({ run_id: r.run_id, task_id: r.task_id, config_id: r.config_id, repeat: r.repeat, objective: r.objective, policy_requested: r.policy_requested, exit_code: r.exit_code, elapsed_ms: Math.round(r.elapsed_ms * 100) / 100, allocation_policy: r.plan?.allocation_policy, model_error: r.plan?.model_error ?? (r.plan ? null : r.parse_error), valid: r.validation.valid, agent: r.plan?.allocation.agent, tools: r.plan?.allocation.tools, budget: r.plan?.allocation.budget, checks_passed: Object.values(r.validation.checks).filter((c) => c.ok).length, checks_total: Object.values(r.validation.checks).length, plan_file: r.plan ? `raw/${r.run_id}.json` : null }) + '\n';
writeFileSync(datasetPath, fd);

// --- CSV summary -----------------------------------------------------------
const csvPath = join(DATA_DIR, 'summary.csv');
let csv = 'run_id,task_id,config_id,repeat,policy_requested,allocation_policy,valid,exit_code,elapsed_ms,context_tokens,tokens,wall_ms,tool_calls,model_error\n';
for (const r of rows) {
  const b = r.plan?.allocation.budget ?? {};
  const csvEsc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const errCell = r.plan ? (r.plan.model_error ?? 'none') : (r.parse_error ?? 'no-plan');
  csv += [r.run_id, r.task_id, r.config_id, r.repeat, r.policy_requested, r.plan?.allocation_policy, r.validation.valid, r.exit_code, Math.round(r.elapsed_ms * 100) / 100, b.context_tokens, b.tokens, b.wall_ms, b.tool_calls, csvEsc(errCell)].join(',') + '\n';
}
writeFileSync(csvPath, csv);

// --- report ----------------------------------------------------------------
const byCfg = {};
for (const r of rows) { (byCfg[r.config_id] = byCfg[r.config_id] || []).push(r); }

function stats(arr, fn) {
  const v = arr.map(fn).filter((x) => x != null);
  if (!v.length) return { n: 0, min: null, max: null, mean: null };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return { n: v.length, min: Math.min(...v), max: Math.max(...v), mean: Math.round(mean * 100) / 100 };
}

function fmtSt(s) { return s ? `**${s.n}** &nbsp; (min ${s.min ?? '-'} / max ${s.max ?? '-'} / mean ${s.mean ?? '-'})` : '—'; }

// aggregate validity per config over the scheduled runs only (exclude repeats)
const schedRows = rows.filter((r) => !String(r.run_id).includes('::rep') && r.plan);

let md = '# phase allocation benchmark — research report\n\n';
md += `_Generated ${new Date().toISOString()} · repo commit ${require_fallback_commit()} · corpus ${corpus.length} tasks · ${CONFIGS.length} configs_\n\n`;

md += `## Method\n\n`;
md += 'The shipped CLI (`bin/phase-alloc.mjs`) was invoked end-to-end against the phase repo for each (task, config) pair. Each run produced a full `phase-alloc-servant-v1` plan. Plans were validated for structure, budget ceiling-compliance, tool whitelist, agent presence, and internal ISA↔allocation consistency. Measurements are wall-clock, in-process (`hrtime`).\n\n';
md += `Budget ceilings enforced by the allocator: context_tokens ≤ 12000, tokens ≤ 24000, wall_ms ≤ 900000, tool_calls ≤ 40, money/human_attention ≥ 0.\n\n`;

md += '## Configurations\n\n| config | policy | SLM endpoint | expected |\n|---|---|---|---|\n';
for (const c of CONFIGS) {
  const exp = c.id === 'model-live' ? 'live model' : c.id === 'heuristic' ? 'deterministic heuristic' : 'model unreachable → heuristic fallback';
  md += `| ${c.id} | ${c.policy} | ${c.base_url} | ${exp} |\n`;
}
md += '\n';

md += '## Corpus\n\n| task | domain | complexity | scale |\n|---|---|---|---|\n';
for (const t of corpus) md += `| ${t.id} | ${t.domain} | ${t.complexity} | ${t.scale_hint} |\n`;
md += '\n';

md += '## Results by configuration (scheduled runs)\n\n';
md += '| config | runs | policy observed | valid | parse fail | mean latency ms |\n|---|---|---|---|---|---|\n';
for (const id of Object.keys(byCfg)) {
  const arr = byCfg[id].filter((r) => !String(r.run_id).includes('::rep'));
  const valid = arr.filter((r) => r.validation.valid).length;
  const parseFail = arr.filter((r) => !r.plan).length;
  const lat = stats(arr, (r) => r.elapsed_ms);
  const policySeen = [...new Set(arr.map((r) => r.plan?.allocation_policy).filter(Boolean))].join(', ') || 'none';
  md += `| ${id} | ${arr.length} | ${policySeen} | ${valid}/${arr.length} | ${parseFail}/${arr.length} | ${fmtSt(lat)} |\n`;
}
md += '\n';

md += '## Allocation policy observed\n\n';
const polCount = {};
for (const r of schedRows) { const p = r.plan?.allocation_policy ?? 'none'; polCount[p] = (polCount[p] || 0) + 1; }
md += '| policy | count |\n|---|---|\n';
for (const [p, c] of Object.entries(polCount).sort((a, b) => b[1] - a[1])) md += `| ${p} | ${c} |\n`;
md += '\n';

md += '## Budget behavior\n\n';
md += '| config | context_tokens (range) | wall_ms (range) | tool_calls (range) | tokens (range) |\n|---|---|---|---|---|\n';
for (const id of Object.keys(byCfg)) {
  const arr = byCfg[id].filter((r) => r.plan && !String(r.run_id).includes('::rep'));
  if (!arr.length) continue;
  const c = (k) => { const v = arr.map((r) => r.plan.allocation.budget[k]); return `${Math.min(...v)}–${Math.max(...v)}`; };
  md += `| ${id} | ${c('context_tokens')} | ${c('wall_ms')} | ${c('tool_calls')} | ${c('tokens')} |\n`;
}
md += '\n';

md += `> Note: the phase allocator's deterministic heuristic always allocates the smallest viable budget — context = ceil(12000 × ${'0.55'}) = 6600, regardless of task. Only the live-SLM path can vary, and only within the caller's ceiling. The near-constant budget across tasks is expected and by-design (no evidence of context misses/failures yet to grow it).\n\n`;

md += '\n## SLM variability (model-live repeats)\n\n';
const reps = rows.filter((r) => String(r.run_id).includes('::rep'));
if (reps.length) {
  for (const r of reps) {
    const b = r.plan?.allocation.budget ?? {};
    md += `- \`${r.run_id}\` → policy=${r.plan?.allocation_policy}, agent=${r.plan?.allocation.agent}, context=${b.context_tokens}, wall_ms=${b.wall_ms}, tools=${(r.plan?.allocation.tools || []).join('+')}, elapsed=${Math.round(r.elapsed_ms)}ms\n`;
  }
}
md += '\n';

// SLM redundancy: duplicate GRANT lines emitted by the SLM in model-live runs
const dupGrants = rows.filter((r) => r.config_id === 'model-live' && r.plan).map((r) => {
  const tl = (r.plan.isa || '').split(/\n/).filter((l) => /^GRANT/.test(l.trim()));
  const set = new Set(tl); const dup = tl.length !== set.size;
  return dup ? { run: r.run_id, grants: tl.map((l) => l.trim()).join(' ') } : null;
}).filter(Boolean);
md += '## SLM redundancy (duplicate GRANT lines in model-live ISA)\n\n';
if (dupGrants.length) {
  md += `${dupGrants.length}/${rows.filter((r) => r.config_id === 'model-live' && r.plan).length} model-live runs emitted a duplicated GRANT line (set-semantics: harmless to allocation, but noisy).\n\n`;
  for (const d of dupGrants) md += `- \`${d.run}\`: ${d.grants}\n`;
} else {
  md += 'None — every model-live run emitted each GRANT once.\n';
}
md += '\n';

md += '## Determinism\n\n';
for (const [taskId, identical] of Object.entries(heurDeterministic)) {
  md += `- heuristic \`${taskId}\` re-run: ${identical ? 'IDENTICAL' : 'DIFFERED'} allocation + ISA\n`;
}
md += '\n';

md += '## Validation failures\n\n';
const fails = rows.filter((r) => !r.validation.valid);
if (fails.length) {
  for (const f of fails) md += `- \`${f.run_id}\`: ${Object.entries(f.validation.checks).filter(([, c]) => !c.ok).map(([n, c]) => `${n}(${c.detail})`).join(', ')}\n`;
} else {
  md += 'None — every plan passed all structural, ceiling, whitelist, and ISA-consistency checks.\n';
}
md += '\n';

md += '## Files\n\n';
md += `- corpus: \`corpus.json\`\n- dataset: \`data/dataset.jsonl\`\n- summary: \`data/summary.csv\`\n- raw plans: \`data/raw/*.json\`\n- this report: \`report.md\`\n`;

writeFileSync(join(ROOT, 'benchmark', 'report.md'), md);

console.log(`wrote ${rows.length} dataset rows\n  dataset: ${datasetPath}\n  csv: ${csvPath}\n  raw: ${RAW_DIR}/${'*'}.json\n  report: ${join(ROOT, 'benchmark', 'report.md')}`);

function require_fallback_commit() {
  try {
    const r = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    return (r.stdout || '').trim() || 'unknown';
  } catch { return 'unknown'; }
}
