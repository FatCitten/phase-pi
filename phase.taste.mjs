/**
 * phase.taste.mjs — THE DIRECTOR'S DIALS.
 *
 * You are the director, not the manager. These few lines are the opinionated,
 * tasteful parts of the project; everything else runs hands-off. Delete any
 * line to fall back to Phase's default. Every value here is read by the
 * geometric decision layer (`src/jev.mjs`) — no model, no training, exact.
 *
 * Delete this file entirely and Phase uses TASTE_DEFAULTS.
 */
export const TASTE = {
  // Geometric alignment → decision bands.
  //   p >= yes  → confident YES (act)      p <= no → confident NO (don't act)
  //   between   → UNKNOWN (escalate to the generative review path)
  // 0.72/0.28 means: STOP only at ≥72% of tickets done; a round that is 50/50
  // is genuinely ambiguous and gets escalated honestly.
  bands: { yes: 0.72, no: 0.28 },

  // How stubborn to be with a broken ticket (geometric retry budget).
  // 2 = retry a failed ticket twice before its work is treated as unfixable
  // and replaced by follow-up work.
  retry: { maxAttempts: 2 },

  // How much new work the generative model may write per round.
  followup: { maxPerRound: 3 },
};