#!/usr/bin/env node
// Targeted test: allocator retries transient SLM failures with backoff, and
// falls back to heuristic when retries are exhausted. Runs offline with a stubbed fetch.
import { PhaseAllocator } from '../src/allocator.mjs';

const baseArgs = {
  workflow: { id: 't', objective: 'x', cwd: process.cwd(), fibers: [{ id: 'F1', agent: 'auto', tools: ['read'], budget: {} }] },
  fiber: { id: 'F1', objective: 'x', agent: 'auto', depends_on: [], tools: ['read'], budget: { tokens: 1000, context_tokens: 800, wall_ms: 900000, tool_calls: 40, money_microunits: 0, human_attention_microunits: 0 } },
  runtime: {},
};

let pass = 0, fail = 0;
function ok(c, m) { console.log(`${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; }

function fakeResponse(asm) {
  return {
    ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: asm } }] }),
  };
}

// --- Case 1: transient failures then success -> policy 'model', retried ---
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) return { ok: true, status: 503, text: async () => 'Service Unavailable' };
    return fakeResponse('ROUTE auto\nGRANT read\nGRANT bash');
  };
  const a = new PhaseAllocator({ policy: 'model', model: { maxRetries: 2, retryDelayMs: 1 } });
  const out = await a.allocate(baseArgs);
  globalThis.fetch = originalFetch;
  ok(calls === 3, `expected 3 fetch attempts, got ${calls}`);
  ok(out.policy === 'model', `expected policy 'model', got '${out.policy}'`);
  ok(out.model_decision.retries === 2, `expected retries=2 metadata, got ${out.model_decision?.retries}`);
  ok(out.tools.includes('read') && out.tools.every(t=>['read'].includes(t)), 'recovered decision is filtered to the fiber-allowed tools');
}

// --- Case 2: always failing -> heuristic-fallback with model_error ---
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
  const a = new PhaseAllocator({ policy: 'model', model: { maxRetries: 1, retryDelayMs: 1 } });
  const out = await a.allocate(baseArgs);
  globalThis.fetch = originalFetch;
  ok(calls === 2, `expected 2 attempts (1 retry), got ${calls}`);
  ok(out.policy === 'heuristic-fallback', `expected heuristic-fallback, got '${out.policy}'`);
  ok(/fetch failed|exhausted retries/.test(String(out.model_error)), `model_error set: ${out.model_error}`);
  ok(Array.isArray(out.tools) && out.tools.length > 0, 'fallback still yields a usable tool list');
}

// --- Case 3: non-transient 401 is not retried ---
{
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401, text: async () => 'unauthorized' }; };
  const a = new PhaseAllocator({ policy: 'model', model: { maxRetries: 3, retryDelayMs: 1 } });
  const out = await a.allocate(baseArgs);
  globalThis.fetch = originalFetch;
  ok(calls === 1, `non-transient 401 must not retry; got ${calls} attempts`);
  ok(out.policy === 'heuristic-fallback', '401 still falls back to heuristic');
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
