/**
 * Jev — the bounded-decision layer of Phase, as exact geometry.
 *
 * Architecture: RULES → JEV → LLM. Jev is NOT a model, an agent, or a planner.
 * It is a zero-parameter geometric readout over the structure the tickets
 * themselves create.
 *
 * THE GEOMETRY (phase-native, after phase-native-llm's ZkBundle)
 *
 *   Every ticket state is a phase on the unit circle — the lifecycle group:
 *
 *       passed  → phase 0      (the "done" anchor)
 *       failed  → phase π      (the "broken" anchor)
 *
 *   Superposing the tickets' state vectors creates the round's geometric
 *   structure:
 *
 *       S = Σᵢ v(φᵢ)        (one vector per ticket, vector sum)
 *
 *   The readout is a cosine projection of S onto the done anchor — the same
 *   Fourier readout ZkBundle uses, and exactly as parameter-free:
 *
 *       alignment      = (S · v_done) / N      ∈ [−1, 1]
 *       goal_satisfied = (1 + alignment) / 2    = exact passed-fraction
 *
 *   All done   → alignment  1 → p = 1    (confident YES → STOP)
 *   All failed → alignment −1 → p = 0    (confident NO)
 *   Half done  → alignment  0 → p = 0.5  (UNKNOWN → escalate to the LLM)
 *
 *   That last line is the point: partial completion is *genuinely* ambiguous,
 *   and the geometry says so honestly instead of guessing.
 *
 *   Follow-up uses the same move after rotation: hypothetically rotate every
 *   retryable failure onto the done anchor; whatever misalignment REMAINS is
 *   work no retry can fix — that is follow-up, measured exactly (unfixable/N).
 *
 * ZERO PARAMETERS. No training, no inference, no network, no API key, no
 * calibration tuning. Judgment is always available and byte-reproducible.
 * The LLM is used only to WRITE new work when the geometry demands it.
 *
 * The opinionated parts are not hidden in code — the director edits
 * `phase.taste.mjs` (see TASTE_DEFAULTS) and the geometry re-reads it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The director's default taste. Centralized; `phase.taste.mjs` overrides. */
export const TASTE_DEFAULTS = Object.freeze({
  // Geometric alignment → decision bands. p >= yes → YES, p <= no → NO, else UNKNOWN.
  bands: Object.freeze({ yes: 0.72, no: 0.28 }),
  // How stubborn to be with a broken ticket before abandoning it.
  retry: Object.freeze({ maxAttempts: 2 }),
  // How much new work the generative model may propose per round.
  followup: Object.freeze({ maxPerRound: 3 }),
  // Real-signal interrogation before STOP. 'git-evidence' (default): a done
  // ticket must have a commit matching its objective, else its phase flips to
  // failed and the geometry re-derives (retry/replace). 'trust-exit-code':
  // bits are taken as truth. Non-git repos are trusted automatically.
  verify: Object.freeze({ beforeStop: 'git-evidence' }),
  // Terminal rule. true (default): STOP only when EVERY ticket sits on the done
  // anchor. false: the director tolerates residual unfixable work — STOP once
  // goal_satisfied >= bands.yes and nothing is retryable.
  stop: Object.freeze({ requireAllDone: true }),
});

export const JEV_POLICY = TASTE_DEFAULTS.bands; // alias: the thresholds Phase owns

/** Each ticket state is a phase on the unit circle. */
export const STATE_PHASE = Object.freeze({ done: 0, failed: Math.PI });

const round4 = (x) => Number(x.toFixed(4));

/**
 * Superpose the round's ticket state-phases into one vector — this IS the
 * geometric structure the tickets create. Zero parameters.
 *
 * @returns {{n, x, y, alignment}} superposition S and its cosine projection
 *   onto the done anchor (alignment = (done − failed)/N for binary states).
 */
export function encodeRound(outcomes = []) {
  // The geometry reads CURRENT state: outcomes arrive as append-only history,
  // so a ticket that failed in round 1 and passed in round 2 must contribute
  // its LATEST phase, not a stale one. Dedupe per ticket, last wins.
  const latest = new Map();
  for (const o of outcomes) latest.set(o.ticket_id, o);
  const current = [...latest.values()];
  const n = current.length;
  let x = 0, y = 0;
  for (const o of current) {
    const phi = o.passed ? STATE_PHASE.done : STATE_PHASE.failed;
    x += Math.cos(phi); y += Math.sin(phi);
  }
  return { n, x, y, alignment: round4(n ? x / n : 1) };
}

/** The exact readout: alignment → probability. (1 + cos Δ)/2, ZkBundle-style. */
export function readoutAlignment(alignment) {
  return round4((1 + alignment) / 2);
}

/**
 * Load the director's taste file (`phase.taste.mjs` in the repo, or
 * `$PHASE_TASTE`). Missing or broken file → defaults; never crashes a session.
 */
export async function loadTaste({ repo = null, env = process.env } = {}) {
  const path = env.PHASE_TASTE || (repo ? join(repo, 'phase.taste.mjs') : null);
  if (!path || !existsSync(path)) return TASTE_DEFAULTS;
  try {
    const m = await import(pathToFileURL(path).href);
    const t = m.TASTE ?? m.default ?? {};
    return {
      bands: { ...TASTE_DEFAULTS.bands, ...(t.bands ?? {}) },
      retry: { ...TASTE_DEFAULTS.retry, ...(t.retry ?? {}) },
      followup: { ...TASTE_DEFAULTS.followup, ...(t.followup ?? {}) },
      verify: { ...TASTE_DEFAULTS.verify, ...(t.verify ?? {}) },
      stop: { ...TASTE_DEFAULTS.stop, ...(t.stop ?? {}) },
    };
  } catch {
    return TASTE_DEFAULTS; // a broken taste file must never break the loop
  }
}

/**
 * The bounded round-review judgment, computed as exact geometry. Zero
 * parameters, no model, always available. Returns the same judgment shape the
 * policy consumes ({goal_satisfied, followup_needed, retries[]}), with the
 * geometric evidence preserved — confidence is never thrown away.
 *
 * @param {Array<{ticket_id,objective,passed,result}>} outcomes
 * @param {{attempts?:Record<string,number>, taste?:object}} opts
 */
export function geometricJudgment(outcomes = [], { attempts = {}, taste = TASTE_DEFAULTS } = {}) {
  // Geometry reads CURRENT state: dedupe the append-only outcome history to
  // each ticket's latest phase before superposing.
  const latest = new Map();
  for (const o of outcomes) latest.set(o.ticket_id, o);
  const current = [...latest.values()];
  const g = encodeRound(current);
  const failed = current.filter((o) => !o.passed);
  const maxAttempts = taste.retry?.maxAttempts ?? TASTE_DEFAULTS.retry.maxAttempts;

  // Bounded retry: a failure is retryable while its attempt phase is still
  // inside the budget anchor. Exact step, zero parameters.
  const retries = failed.map((o) => {
    const used = Number(attempts[o.ticket_id] ?? 0);
    return { ticket_id: o.ticket_id, probability: used < maxAttempts ? 1 : 0, attempts: used };
  });

  // Follow-up: rotate every retryable failure onto the done anchor; whatever
  // misalignment remains is work no retry can fix. Its PRESENCE is the exact
  // signal that replacement work is needed (the amount stays in geometry).
  const unfixable = failed.filter((o) => Number(attempts[o.ticket_id] ?? 0) >= maxAttempts).length;
  const followup_needed = unfixable > 0 ? 1 : 0;
  const residual_alignment = round4(g.n ? (g.n - 2 * unfixable) / g.n : 1);

  return {
    source: 'jev',
    kind: 'geometry',
    model: 'phase-native/zero-param',
    geometry: { ...g, failed: failed.length, retryable: failed.length - unfixable, unfixable, residual_alignment },
    goal_satisfied: readoutAlignment(g.alignment), // exact passed-fraction
    followup_needed,                                // exact: unfixable work present
    retries: retries.map(({ ticket_id, probability }) => ({ ticket_id, probability })),
  };
}

/**
 * Pure decision policy: map judgment probabilities to a bounded Phase action.
 *
 * Jev decides WHETHER; the generative model decides WHAT (it writes ADD text).
 * Precedence is geometric — bounded work first, terminal states last:
 *
 *   1. retryable failures exist        → RETRY (a fixable ticket is never
 *                                         abandoned while a bounded action exists)
 *   2. unfixable failures exist        → FOLLOWUP (the LLM writes replacements)
 *   3. geometry clean + satisfied      → STOP
 *   4. otherwise                       → NOOP
 *
 * Escalation survives as the safety net for non-geometric advisors (a missing
 * or malformed judgment must never be guessed at).
 *
 * @param {object} judgment   from `geometricJudgment` (or any advisor)
 * @param {object} opts
 * @param {Array}  opts.outcomes  original round outcomes (for retry validation)
 * @param {object} [opts.policy]  threshold policy (default JEV_POLICY)
 * @param {object} [opts.taste]   full taste (for the terminal rule)
 * @returns {{action, stop, retries, followup, escalation, decisions}}
 */
export function applyJevPolicy(judgment, { outcomes = [], policy = JEV_POLICY, taste = TASTE_DEFAULTS } = {}) {
  const failedIds = new Set((outcomes || []).filter((o) => !o.passed).map((o) => o.ticket_id));
  const classify = (p) =>
    typeof p === 'number' && Number.isFinite(p)
      ? p >= policy.yes ? 'YES' : (p <= policy.no ? 'NO' : 'UNKNOWN')
      : 'UNKNOWN';

  const gsAnswer = classify(judgment.goal_satisfied);
  const fnAnswer = classify(judgment.followup_needed);
  const decisions = [
    { source: 'jev', question: 'goal_satisfied', probability: judgment.goal_satisfied ?? null, answer: gsAnswer },
    { source: 'jev', question: 'followup_needed', probability: judgment.followup_needed ?? null, answer: fnAnswer },
  ];

  // Safety net for garbage: a missing/malformed judgment (e.g. a broken
  // foreign advisor) is never guessed at. Exact geometry never lands here.
  const malformed = [judgment.goal_satisfied, judgment.followup_needed]
    .some((p) => typeof p !== 'number' || !Number.isFinite(p));
  if (malformed) {
    return {
      escalation: true, action: 'ESCALATE',
      reason: 'malformed judgment (missing probabilities) -> escalate to generative review',
      stop: false, retries: [], followup: false, decisions,
    };
  }

  // 1. Bounded work first: retry fixable failures (validated against reality).
  //    A fixable ticket is never abandoned — not even when the goal band looks
  //    "satisfied enough"; finishing beats shipping residue.
  const retries = [];
  for (const r of judgment.retries ?? []) {
    if (!failedIds.has(r.ticket_id)) continue; // Phase safety: only actual failed tickets
    const c = classify(r.probability);
    decisions.push({ source: 'jev', question: 'retry', ticket_id: r.ticket_id, probability: r.probability, answer: c });
    if (c === 'YES') retries.push(r.ticket_id);
  }
  if (retries.length) {
    return { escalation: false, action: 'RETRY', stop: false, retries, followup: fnAnswer === 'YES', decisions };
  }

  // 2. Unfixable work present -> the generative model writes replacements…
  //    …unless the director has dialled "ship with known-broken residue".
  const requireAllDone = taste?.stop?.requireAllDone ?? true;
  if (fnAnswer === 'YES' && requireAllDone) {
    return { escalation: false, action: 'FOLLOWUP', stop: false, retries: [], followup: true, decisions };
  }

  // 3. Terminal: the director decides how clean "done" must be.
  if (requireAllDone ? judgment.geometry?.alignment === 1 : gsAnswer === 'YES') {
    return { escalation: false, action: 'STOP', stop: true, retries: [], followup: false, decisions };
  }

  // 4. Band-ambiguous AND nothing bounded actionable -> escalate honestly.
  if (gsAnswer === 'UNKNOWN') {
    return {
      escalation: true, action: 'ESCALATE',
      reason: 'ambiguous judgment with no bounded action available -> escalate to generative review',
      stop: false, retries: [], followup: false, decisions,
    };
  }

  // 5. Nothing bounded is actionable.
  return { escalation: false, action: 'NOOP', stop: false, retries: [], followup: false, decisions };
}