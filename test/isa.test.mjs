import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGETS,
  ISAAllocator,
  RESOURCES,
  SYSTEM_PROMPT,
  clampISA,
  heuristic,
  parseISA,
  pickJson,
  toISA,
} from '../src/allocator.mjs';

test('parseISA: full assembly', () => {
  const d = parseISA('ROUTE exec\nALLOC TOKENS 1000\nALLOC WALL_MS 60000\nGRANT read\nGRANT edit\n');
  assert.equal(d.agent, 'exec');
  assert.equal(d.tokens, 1000);
  assert.equal(d.wall_ms, 60000);
  assert.deepEqual(d.tools, ['read', 'edit']);
});

test('parseISA: GRANT is a set, ROUTE/ALLOC are last-wins', () => {
  const d = parseISA('ROUTE a\nROUTE b\nGRANT read\nGRANT read\nGRANT edit\nALLOC TOKENS 1\nALLOC TOKENS 2\n');
  assert.equal(d.agent, 'b');
  assert.deepEqual(d.tools, ['read', 'edit']);
  assert.equal(d.tokens, 2);
});

test('parseISA: inline comments stripped, blank lines ignored', () => {
  const d = parseISA('ROUTE exec ; the agent that runs\n\nGRANT read ; read access\n');
  assert.equal(d.agent, 'exec');
  assert.deepEqual(d.tools, ['read']);
});

test('parseISA: unknown ops ignored, but pure prose throws', () => {
  assert.throws(() => parseISA('Here is a nice paragraph about allocation.'), /no ISA assembly/);
  assert.throws(() => parseISA(''), /no ISA assembly/);
});

test('pickJson: salvages a JSON answer, bare or wrapped in prose', () => {
  const d = pickJson('{"agent":"exec","tools":["read"],"tokens":500}');
  assert.equal(d.agent, 'exec');
  const wrapped = pickJson('sure! here you go: { "agent": "exec" }');
  assert.equal(wrapped.agent, 'exec');
  assert.throws(() => pickJson('nothing here'), /neither ISA assembly nor JSON/);
});

test('toISA: deterministic, deduped, roundtrips through parseISA', () => {
  const allocation = {
    agent: 'exec',
    tools: ['read', 'read', 'edit'],
    budget: { context_tokens: 16000, tokens: 32000, wall_ms: 900000, tool_calls: 48, money_microunits: 0, human_attention_microunits: 0 },
  };
  const asm = toISA(allocation);
  assert.ok(asm.startsWith('ROUTE exec'));
  assert.equal((asm.match(/GRANT read/g) ?? []).length, 1);
  const back = parseISA(asm);
  assert.equal(back.agent, 'exec');
  assert.equal(back.context_tokens, 16000);
  assert.deepEqual(back.tools, ['read', 'edit']);
});

test('heuristic: ceilings respected, context halved, tools pass through', () => {
  const a = heuristic({ objective: 'x', tools: ['read', 'test'], budget: { ...DEFAULT_BUDGETS } });
  assert.equal(a.policy, 'heuristic');
  assert.equal(a.schema, 'isa-allocation-v1');
  assert.equal(a.agent, 'auto');
  assert.deepEqual(a.tools, ['read', 'test']);
  assert.equal(a.budget.context_tokens, DEFAULT_BUDGETS.context_tokens / 2);
  assert.equal(a.budget.tokens, DEFAULT_BUDGETS.tokens);
});

test('clampISA: above-ceiling values clamped, foreign agent rejected, tools filtered', () => {
  const base = heuristic({ objective: 'x', tools: ['read', 'edit'], budget: { ...DEFAULT_BUDGETS } });
  const out = clampISA(
    base,
    { agent: 'rogue', tools: ['edit', 'rm'], tokens: 10 ** 9, context_tokens: 0.5 },
    { allowedTools: new Set(['read', 'edit']), allowedAgents: new Set([base.agent]) },
  );
  assert.equal(out.agent, base.agent);
  assert.deepEqual(out.tools, ['edit']);
  assert.equal(out.budget.tokens, base.budget.tokens); // clamped to the ceiling
  assert.ok(out.budget.context_tokens >= 1); // floored at 1
});

test('clampISA: zero ceilings stay zero (money, attention)', () => {
  const base = heuristic({ objective: 'x', tools: [], budget: { ...DEFAULT_BUDGETS } });
  const out = clampISA(base, { money_microunits: 1000 }, {});
  assert.equal(out.budget.money_microunits, 0);
});

test('clampISA: missing values fall back to the heuristic baseline', () => {
  const base = heuristic({ objective: 'x', tools: ['read'], budget: { ...DEFAULT_BUDGETS } });
  const out = clampISA(base, { agent: base.agent }, {});
  assert.equal(out.budget.wall_ms, base.budget.wall_ms);
  assert.equal(out.policy, 'model');
});

test('ISAAllocator: heuristic policy emits schema and asm', async () => {
  const allocator = new ISAAllocator({ policy: 'heuristic' });
  const out = await allocator.allocate({ objective: 'add rate limiting', tools: ['read'], budget: { ...DEFAULT_BUDGETS } });
  assert.equal(out.schema, 'isa-allocation-v1');
  assert.match(out.asm, /^ROUTE /);
  assert.match(out.asm, /ALLOC CONTEXT_TOKENS/);
});

test('RESOURCES: the six resources in stable order', () => {
  assert.deepEqual(
    RESOURCES.map(([tag]) => tag),
    ['CONTEXT_TOKENS', 'TOKENS', 'WALL_MS', 'TOOL_CALLS', 'MONEY_MICROUNITS', 'HUMAN_ATTENTION_MICROUNITS'],
  );
});

test('SYSTEM_PROMPT: names the instructions, one rule per line, small', () => {
  assert.match(SYSTEM_PROMPT, /ROUTE/);
  assert.match(SYSTEM_PROMPT, /GRANT/);
  assert.match(SYSTEM_PROMPT, /ALLOC/);
  assert.ok(SYSTEM_PROMPT.length < 2000);
});
