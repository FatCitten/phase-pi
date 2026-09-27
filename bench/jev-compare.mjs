#!/usr/bin/env node
/**
 * bench/jev-compare.mjs — our geometric Jev vs the hosted TypeSafe Jev.
 *
 * Same round-review questions, same decision policy, two judges:
 *   OURS  — src/jev.mjs: zero-parameter geometry (exact passed-fraction readout)
 *   REAL  — POST https://api.typesafe.ai/v1/systemone (Noul probabilities)
 *
 * Usage:
 *   TYPESAFE_API_KEY=sk-... node bench/jev-compare.mjs [--scenarios N] [--out FILE]
 *
 * Without a key it still prints OUR numbers (exact by construction) and states
 * plainly that the real-Jev arm was skipped — no fake numbers, ever.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { geometricJudgment, applyJevPolicy, TASTE_DEFAULTS, JEV_POLICY } from '../src/jev.mjs';

const API = 'https://api.typesafe.ai/v1/systemone';
const KEY = process.env.TYPESAFE_API_KEY || '';
const MODEL = process.env.PHASE_JEV_MODEL || 'jev-latest';

const pass = (id, result = 'ok') => ({ ticket_id: id, objective: `do ${id}`, passed: true, result });
const fail = (id, result = 'failed with error: boom', attempts = 0) => ({ ticket_id: id, objective: `do ${id}`, passed: false, result, attempts });

// Deterministic scenario grid covering every region of the decision space.
const SCENARIOS = [
  { name: 'all-done (n=1)', outcomes: [pass('A')], attempts: {} },
  { name: 'all-done (n=4)', outcomes: [pass('A'), pass('B'), pass('C'), pass('D')], attempts: {} },
  { name: 'all-failed, fresh (n=3)', outcomes: [fail('A'), fail('B'), fail('C')], attempts: { A: 0, B: 0, C: 0 } },
  { name: 'half-done (n=2)', outcomes: [pass('A'), fail('B')], attempts: { B: 0 } },
  { name: 'three-quarters, retryable (n=4)', outcomes: [pass('A'), pass('B'), pass('C'), fail('D')], attempts: { D: 0 } },
  { name: 'unfixable residue (n=4)', outcomes: [pass('A'), pass('B'), pass('C'), fail('D', 'failed after retries')], attempts: { D: 2 } },
  { name: 'mixed budgets (n=4)', outcomes: [pass('A'), fail('B'), fail('C'), fail('D', 'exit 1')], attempts: { B: 1, C: 0, D: 5 } },
  { name: 'one pass only (n=5)', outcomes: [pass('A'), fail('B'), fail('C'), fail('D'), fail('E', 'missing')], attempts: { B: 0, C: 2, D: 0, E: 0 } },
];

const NOUL = {
  goal_satisfied: {
    type: 'noul',
    instructions: 'Has the overall goal been satisfactorily completed based only on the supplied evidence?',
    criteria: { true: 'All work needed to consider the goal complete is represented and passed', false: 'Failed tickets, missing work, or other evidence shows the goal still needs work' },
  },
  followup_needed: {
    type: 'noul',
    instructions: 'Is additional work required that is not represented by an existing failed ticket (for example a follow-up subtask)?',
  },
};

/** Build the same Jev wire questions our integration used to ask. */
function buildQuestions(outcomes, attempts, taste = TASTE_DEFAULTS) {
  const questions = { ...NOUL };
  const failed = outcomes.filter((o) => !o.passed);
  failed.forEach((o, i) => {
    const budget = attempts[o.ticket_id] ?? 0;
    questions[`retry_${i}`] = {
      type: 'noul',
      instructions: `Should failed ticket ${o.ticket_id} — "${String(o.objective).slice(0, 120)}" — be retried rather than abandoned or replaced?`,
      criteria: { true: 'A retry is worth attempting', false: 'Retrying is not worth it or the ticket should be abandoned/replaced' },
      _attempts: budget,
      _ticket_id: o.ticket_id,
    };
  });
  return questions;
}

/** Ask the hosted Jev API; returns a judgment object or null (with reason). */
async function realJev(state, questions) {
  const t0 = performance.now();
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: AbortSignal.timeout(30000),
    });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) return { error: `HTTP ${r.status}`, body: (await r.text()).slice(0, 200), ms };
    const j = await r.json();
    const ans = j.answers ?? {};
    const retries = Object.entries(questions)
      .filter(([k, q]) => k.startsWith('retry_'))
      .map(([k, q]) => ({ ticket_id: q._ticket_id, probability: ans[k]?.noul ?? null }));
    return {
      ms, usage: j.usage, model: j.model,
      goal_satisfied: ans.goal_satisfied?.noul ?? null,
      followup_needed: ans.followup_needed?.noul ?? null,
      retries,
    };
  } catch (e) {
    return { error: String(e.message || e), ms: Math.round(performance.now() - t0) };
  }
}

/** Map a judgment through the SAME policy both sides are judged by. */
function actionOf(judgment, outcomes, requireAllDone = false) {
  const taste = { ...TASTE_DEFAULTS, stop: { requireAllDone } };
  return applyJevPolicy(judgment, { outcomes, policy: JEV_POLICY, taste }).action;
}

async function main() {
  const rows = [];
  for (const s of SCENARIOS) {
    const { outcomes, attempts } = s;
    const state = { goal: '(benchmark round)', tickets: outcomes.map(({ ticket_id, objective, passed, result }) => ({ ticket_id, objective, passed, result })) };
    const t0 = performance.now();
    const ours = geometricJudgment(outcomes, { attempts, taste: TASTE_DEFAULTS });
    const oursMs = Math.round((performance.now() - t0) * 1000) / 1000;
    const oursActionStr = actionOf(ours, outcomes, false); // band-only: both judges scored identically
    const shippedDefault = actionOf(ours, outcomes, true);  // our requireAllDone default

    const questions = buildQuestions(outcomes, attempts);
    const real = KEY ? await realJev(state, questions) : { skipped: 'no TYPESAFE_API_KEY' };
    const realJudgment = real.goal_satisfied != null ? { ...real, retries: real.retries ?? [] } : null;
    const realAction = realJudgment ? actionOf(realJudgment, outcomes, false) : null;

    rows.push({
      name: s.name,
      ours: {
        goal_satisfied: ours.goal_satisfied, followup_needed: ours.followup_needed,
        retries: ours.retries, action: oursActionStr, shipped_default: shippedDefault, ms: oursMs,
        geometry: { alignment: ours.geometry.alignment, unfixable: ours.geometry.unfixable },
      },
      real: real.skipped ? { skipped: real.skipped } : {
        goal_satisfied: real.goal_satisfied, followup_needed: real.followup_needed,
        retries: (real.retries ?? []).map((r) => ({ ticket_id: r.ticket_id, probability: r.probability })),
        action: realAction?.action ?? null, ms: real.ms,
        usage: real.usage, model: real.model, error: real.error,
      },
      delta: (real.goal_satisfied != null) ? {
        goal_satisfied: Math.abs(ours.goal_satisfied - real.goal_satisfied),
        followup_needed: (real.followup_needed != null) ? Math.abs(ours.followup_needed - real.followup_needed) : null,
        action_agrees: realAction ? oursAction.action === realAction.action : null,
      } : null,
    });
  }

  // Summary over comparable rows.
  const comparable = rows.filter((r) => r.delta);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const summary = {
    scenario_count: rows.length,
    real_jev_available: comparable.length > 0,
    mean_abs_delta: {
      goal_satisfied: mean(comparable.map((r) => r.delta.goal_satisfied)),
      followup_needed: mean(comparable.map((r) => r.delta.followup_needed).filter((v) => v != null)),
    },
    action_agreement: comparable.length
      ? Math.round((comparable.filter((r) => r.delta.action_agrees).length / comparable.length) * 100) + '%'
      : null,
    
    ours_total_ms: Math.round(rows.reduce((a, r) => a + (r.ours?.ms ?? 0), 0) * 1000) / 1000,
  };

  // ---- report ----
  console.log('# Our geometric Jev vs hosted TypeSafe Jev');
  console.log('');
  for (const r of rows) {
    const o = r.ours, x = r.real;
    console.log(`## ${r.name}`);
    console.log(`  ours : goal=${o.goal_satisfied} followup=${o.followup_needed} retries=[${o.retries.map((t) => t.ticket_id + ':' + t.probability).join(', ') || '-'}] action=${o.action} (shipped-default: ${o.shipped_default}) [${o.geometry.alignment} alignment, ${o.ms}ms]`);
    if (x.skipped) console.log(`  real : skipped — ${x.skipped}`);
    else if (x.error) console.log(`  real : ERROR ${x.error} (${x.ms}ms)`);
    else {
      console.log(`  real : goal=${x.goal_satisfied} followup=${x.followup_needed} retries=[${(x.retries ?? []).map((t) => t.ticket_id + ':' + t.probability).join(', ') || '-'}] action=${x.action} [${x.model}, ${x.usage?.input_tokens ?? '?'}in tok, ${x.ms}ms]`);
      if (r.delta) console.log(`  delta: |Δgoal|=${r.delta.goal_satisfied} |Δfollowup|=${r.delta.followup_needed ?? '-'} actions_agree=${r.delta.action_agrees}`);
    }
    console.log('');
  }
  console.log('SUMMARY ' + JSON.stringify(summary, null, 2));

  mkdirSync('results', { recursive: true });
  writeFileSync('results/jev-compare.json', JSON.stringify({ summary, rows }, null, 2));
  console.log('\nsaved: results/jev-compare.json');
}

main();