/**
 * Jev-as-geometry tests. The kernel is exact and zero-parameter, so these tests
 * assert EXACTNESS (ZkBundle-style: 100% at step 0) — not statistical behavior.
 * No network, no model, no API key. Deterministic by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeRound, readoutAlignment, geometricJudgment, applyJevPolicy,
  loadTaste, TASTE_DEFAULTS, JEV_POLICY, STATE_PHASE,
} from '../src/jev.mjs';
import { decideNext, generativeReview, decomposeGoal, parsePlan } from '../src/orchestrator.mjs';

const pass = (id) => ({ ticket_id: id, objective: `do ${id}`, passed: true, result: 'ok' });
const fail = (id) => ({ ticket_id: id, objective: `do ${id}`, passed: false, result: 'failed: error' });

// ---- exact geometry: the readout IS the passed-fraction ----
test('geometry: superposition of state phases → exact passed-fraction (zero params)', () => {
  // 0/2, 1/2, 2/2 … every fraction must be exact, like ZkBundle at step 0.
  for (let k = 0; k <= 4; k++) {
    const outcomes = [
      ...Array.from({ length: k }, (_, i) => pass(`P${i}`)),
      ...Array.from({ length: 4 - k }, (_, i) => fail(`F${i}`)),
    ];
    const g = encodeRound(outcomes);
    assert.equal(readoutAlignment(g.alignment), k / 4, `k=${k}`);
  }
  // All done → alignment exactly 1 (confident YES).
  assert.equal(encodeRound([pass('A'), pass('B'), pass('C')]).alignment, 1);
  // All failed → alignment exactly −1 (confident NO).
  assert.equal(encodeRound([fail('A'), fail('B')]).alignment, -1);
  // Half → exactly 0 (honestly ambiguous).
  assert.equal(encodeRound([pass('A'), fail('B')]).alignment, 0);
});

test('geometry: judgment preserves geometric evidence as confidence', () => {
  const j = geometricJudgment([pass('A'), fail('B')]);
  assert.equal(j.kind, 'geometry');
  assert.equal(j.model, 'phase-native/zero-param');
  assert.equal(j.goal_satisfied, 0.5);       // exact (binary states → exact fractions)
  assert.equal(j.geometry.alignment, 0);
  assert.equal(j.geometry.failed, 1);
  assert.equal(j.retries[0].probability, 1); // attempts 0 < budget 2 → retryable
});

test('geometry reads CURRENT state: append-only history is deduped (latest phase wins)', () => {
  // A ticket that failed in round 1 and passed in round 2 is DONE, not failed.
  const history = [fail('A'), fail('B'), pass('A')]; // stale round-1 failure of A
  const g = encodeRound(history);
  assert.equal(g.alignment, 0);            // A done + B failed → 1 done, 1 failed
  const j = geometricJudgment(history, { taste: TASTE_DEFAULTS });
  assert.equal(j.goal_satisfied, 0.5);
  assert.deepEqual(j.retries.map((r) => r.ticket_id), ['B']); // A is no longer failed
});

// ---- the four bounded decisions ----
test('all tickets done → STOP (exact, no model consulted)', async () => {
  const r = await decideNext({
    goal: 'g', outcomes: [pass('A'), pass('B')], repo: '/nonexistent',
    model: 'm', base_url: 'http://127.0.0.1:1', // unreachable: must NOT be touched
    taste: TASTE_DEFAULTS,
  });
  assert.equal(r.stop, true);
  assert.deepEqual(r.retries, []);
  assert.equal(r.fallback, false);
  assert.equal(r.jev.judgment.geometry.alignment, 1);
});

test('confidently retryable failures → RETRY (bounded work beats terminal STOP)', () => {
  const outcomes = [fail('A'), fail('B')];
  const j = geometricJudgment(outcomes, { attempts: { A: 0, B: 5 }, taste: TASTE_DEFAULTS });
  const d = applyJevPolicy(j, { outcomes, taste: TASTE_DEFAULTS });
  assert.equal(d.action, 'RETRY');
  assert.deepEqual(d.retries, ['A']);      // A still inside its budget
  assert.equal(d.followup, true);          // B is dead: replacement work flagged too
});

test('a fixable ticket is never abandoned while its budget remains', () => {
  // 75% done with one retryable failure: the geometry says RETRY, not STOP —
  // even though bands.yes would call 0.75 "satisfied". Bounded work first.
  const outcomes = [pass('A'), pass('B'), pass('C'), fail('D')];
  const j = geometricJudgment(outcomes, { attempts: { D: 0 }, taste: TASTE_DEFAULTS });
  const d = applyJevPolicy(j, { outcomes, taste: TASTE_DEFAULTS });
  assert.equal(d.action, 'RETRY');
  assert.equal(d.stop, false);
  assert.deepEqual(d.retries, ['D']);
});

test('failed ticket beyond the retry budget → no retry, follow-up instead', () => {
  const outcomes = [fail('A')];
  const j = geometricJudgment(outcomes, { attempts: { A: 2 }, taste: TASTE_DEFAULTS });
  const d = applyJevPolicy(j, { outcomes });
  assert.deepEqual(d.retries, []);      // budget exhausted
  assert.equal(d.followup, true);       // replacement work is needed
  assert.equal(d.action, 'FOLLOWUP');
  assert.equal(j.geometry.unfixable, 1);
});

test('Phase may not retry a ticket that did not fail', () => {
  const outcomes = [fail('A'), pass('B')];
  const j = geometricJudgment(outcomes, { attempts: { A: 0 } });
  j.retries.push({ ticket_id: 'B', probability: 1 }); // forged: B passed
  const d = applyJevPolicy(j, { outcomes, taste: TASTE_DEFAULTS });
  assert.deepEqual(d.retries, ['A']);
});

// ---- Jev never writes text; the LLM does ----
test('Jev decides WHETHER; only the generative path decides WHAT', async () => {
  const adds = [{ objective: 'Add regression coverage for malformed refresh tokens', depends_on: [] }];
  const server = stubGenerative(adds);
  await server.up();
  try {
    const outcomes = [fail('A')];
    const r = await decideNext({
      goal: 'g', outcomes, repo: '/nonexistent', model: 'm', base_url: server.url,
      attempts: { A: 9 }, taste: TASTE_DEFAULTS, // unfixable → follow-up needed
    });
    assert.equal(r.followup_via, 'generative');
    assert.deepEqual(r.adds, adds); // text came from the generative model
    assert.equal(Object.keys(r.jev.judgment).filter((k) => /objective|adds|text/.test(k)).length, 0);
  } finally { await server.down(); }
});

// ---- honest ambiguity ----
test('foreign/ambiguous judgment → escalate (safety net, never guessed)', async () => {
  const server = stubGenerative([{ objective: 'x', depends_on: [] }]);
  await server.up();
  try {
    // A non-geometric advisor returning a malformed judgment must not be acted
    // on: the policy escalates to the generative review path instead.
    const r = await decideNext({
      goal: 'g', outcomes: [pass('A')], repo: '/nonexistent',
      model: 'm', base_url: server.url, taste: TASTE_DEFAULTS,
      jevJudgment: () => ({ goal_satisfied: null, followup_needed: null, retries: [] }),
    });
    assert.equal(r.jev.decision.escalation, true);
    assert.equal(r.jev.escalated, true);
  } finally { await server.down(); }
});

// ---- default taste is hands-off: partial rounds retry, they do not nag the LLM ----
test('partial rounds with fixable work never escalate — hands-off by default', () => {
  for (const outcomes of [[fail('A')], [fail('A'), fail('B')], [pass('A'), fail('B'), fail('C')]]) {
    const j = geometricJudgment(outcomes, { taste: TASTE_DEFAULTS });
    const d = applyJevPolicy(j, { outcomes, taste: TASTE_DEFAULTS });
    assert.notEqual(d.escalation, true, JSON.stringify(outcomes)); // no LLM review call
    assert.ok(['RETRY', 'FOLLOWUP'].includes(d.action), d.action);
  }
});

// ---- the director's dials ----
test('taste: the terminal rule is a real dial (director, not manager)', () => {
  // 3 done, 1 unfixable failure: default taste replaces the dead work.
  const outcomes = [pass('A'), pass('B'), pass('C'), fail('D')];
  const j = geometricJudgment(outcomes, { attempts: { D: 9 }, taste: TASTE_DEFAULTS });
  const d1 = applyJevPolicy(j, { outcomes, taste: TASTE_DEFAULTS });
  assert.equal(d1.action, 'FOLLOWUP');
  // One line flipped: "ship with known-broken residue" → STOP instead.
  const tolerant = { ...TASTE_DEFAULTS, stop: { requireAllDone: false } };
  const d2 = applyJevPolicy(j, { outcomes, taste: tolerant });
  assert.equal(d2.action, 'STOP');
  assert.equal(d2.stop, true);
  // And back: requiring all-done is the conservative default.
  assert.equal(TASTE_DEFAULTS.stop.requireAllDone, true);
});

test('taste: retry budget line changes retryability', () => {
  const outcomes = [fail('A')];
  const j1 = geometricJudgment(outcomes, { attempts: { A: 1 }, taste: { ...TASTE_DEFAULTS, retry: { maxAttempts: 2 } } });
  const j2 = geometricJudgment(outcomes, { attempts: { A: 1 }, taste: { ...TASTE_DEFAULTS, retry: { maxAttempts: 1 } } });
  assert.equal(j1.retries[0].probability, 1); // budget 2 → still retryable
  assert.equal(j2.retries[0].probability, 0); // budget 1 → spent
});

test('taste file loads from a repo; broken file falls back to defaults', async () => {
  const t = await loadTaste({ repo: '/nonexistent' });
  assert.deepEqual(t, TASTE_DEFAULTS);
});

// ---- deterministic fallbacks remain viable ----
test('generative review still degrades deterministically', async () => {
  const r = await generativeReview({
    goal: 'g', outcomes: [fail('A'), pass('B')], repo: '.',
    model: 'm', base_url: 'http://127.0.0.1:1', fallback: true,
  });
  assert.equal(r.fallback, true);
  assert.deepEqual(r.retries, ['A']);
});

test('parsePlan / decomposeGoal unchanged', async () => {
  assert.equal(parsePlan('STOP').stop, true);
  const p = await decomposeGoal({ goal: 'A. B. C.', repo: '.', model: 'm', base_url: 'http://127.0.0.1:1', fallback: true });
  assert.equal(p.fallback, true);
});

// ---- no fake success ----
test('follow-up needed but generative fails → surfaced, never fabricated', async () => {
  const r = await decideNext({
    goal: 'g', outcomes: [fail('A')], repo: '/nonexistent', model: 'm',
    base_url: 'http://127.0.0.1:1', attempts: { A: 9 }, taste: TASTE_DEFAULTS,
  });
  assert.equal(r.followup_generation_failed, true);
  assert.deepEqual(r.adds, []);
});

// ---------- tiny in-test OpenAI-compatible /chat/completions stub ----------
function stubGenerative(adds) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const content = adds.map((a) => `ADD "${a.objective}"`).join('\n');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return {
    url: null,
    async up() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); this.url = `http://127.0.0.1:${server.address().port}/v1`; return this; },
    async down() { await new Promise((r) => server.close(r)); },
  };
}

import { createServer } from 'node:http';