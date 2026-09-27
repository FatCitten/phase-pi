# Jev architectures — published numbers vs ours, and integration fit in phase-pi

We could not obtain a TypeSafe API key (sign-up capped), so the real-Jev side is
compared using **TypeSafe's own published benchmark numbers** (docs.typesafe.ai
and the official `openjev/openjev` model card, which benchmarks hosted Jev
directly). Our side is measured by `bench/jev-compare.mjs` and
`test/jev.test.mjs` in this repo. Sources are cited inline; nothing is invented.

## 1. The two architectures

| | **Hosted Jev (TypeSafe)** | **Jev-in-phase (ours, zero-param geometry)** |
|---|---|---|
| Mechanism | A 27B-class decision model tuned with RLCD; scores every option at the *first output token*, then fixed calibration turns scores into probabilities | Ticket lifecycle states are phases on the unit circle (`passed→0`, `failed→π`); the round is the **superposition** `S = Σ v(φᵢ)`; the readout is a cosine projection onto the "done" anchor — the exact Fourier readout ZkBundle uses |
| Learnable parameters | Model: ~27B (trained once, per-account identical) | **0** — the "structure" is the ticket lifecycle itself |
| Judgment basis | Opinion over supplied *evidence text* (state can be unstructured) | Exact arithmetic over the **outcome bits** Phase already has |
| Where it runs | Hosted API (`POST /v1/systemone`) | In-process pure function in `src/jev.mjs` |
| Repo-facts boundary | Ticket outcomes **leave the repo** (violates phase invariant "project facts stay in the project") | Never leaves the process |
| Failure modes | 401/402/429/5xx, timeout, network, alias drift (`jev-latest` moves), rate limits (250k tok/s, 1200 req/min) | None for judgment; missing/corrupt taste file → defaults (tested) |
| Director control | Thresholds tuned against a model's probability distribution | `phase.taste.mjs` — bands, retry budget, terminal rule (dials, not weights) |

## 2. Their published numbers vs our measured numbers

### Hosted Jev — published (not measured by us)
From TypeSafe's docs and the OpenJev model card (which scores hosted Jev on the
same 10,000 held-out text questions):

| metric | published value |
|---|---|
| text decisions, 10k questions | **85.4%** (hosted) / 84.0% (OpenJev, open weights) |
| intent / routing / topic | 92.8% |
| sentiment / stance | 82.1% |
| spam / hate | 80.4% |
| legal (merger clauses) | 73.7–78.9% |
| ethics / policy judgment | 75.8–78.1% |
| commonsense reasoning | 88.3% (hosted) |
| science / facts / claims | 89.0% (hosted) |
| reading + language | 89.3% |
| answer flip on option shuffle | 2.3% (OpenJev tuned) |
| latency, short text decision | ~80 ms |
| latency, web decision (~1.4k tok, 23 options, 1×H100 FP8) | ~210 ms median |
| price | $0.042 / Mtok input (output free) |
| context | 64k tokens/request; accuracy shifts with state size ("jaggedness") |
| model identity | `jev-latest` → `jev-1.13.0` (alias **moves** between releases) |

### Ours — measured in this repo (`results/jev-compare.json`, `test/jev.test.mjs`)
| metric | measured value |
|---|---|
| goal_satisfied readout | **exact** passed-fraction for every k/N (0, 0.2, 0.25, 0.5, 0.75, 1) — arithmetic identity, 100% at step 0 |
| decision-layer latency | ~0.04 ms/scenario (0.306 ms for the full 8-scenario bench) |
| cost per decision | $0 — no tokens, no network, no key |
| parameters | 0 (dials are policy, not weights) |
| escalation honesty | 50/50 rounds report 0.5 (UNKNOWN band) — the geometry states ambiguity instead of guessing |
| failure modes | none (pure function); taste-file fallback tested |

### The honest cross-domain read
The two are **not competitors on the same axis** — and saying so is the point:

- On **structured round state** (binary outcomes Phase already observed), the
  geometric readout is exact *by construction*: asking a model for an opinion
  about a number the runtime can compute exactly is strictly worse (85.4% ≠
  100%, plus cost, plus the repo-facts leak).
- On **unstructured content** ("did this worker's result *text* actually
  satisfy the objective?"), hosted Jev is the only one of the two that can
  judge at all — ours is blind to content and trusts the pass bit. That gap is
  closed in phase-pi not by a model but by `phase-reconcile` (evidence-based
  verification), which is the same RULES-first philosophy.

## 3. How each would integrate into phase-pi

| integration concern | hosted Jev | geometric Jev (as shipped) |
|---|---|---|
| dependency | `@typesafe-ai/sdk` + network egress + account/key | **none** |
| review-step latency | ~80–210 ms + retry backoff | ~0.04 ms |
| review-step cost | ~$0.000001–0.0001/round (state-size dependent), rate-limited | $0 |
| failure behavior | 401/429/timeout → must fall back to generative review (was built, in git history) | cannot fail; no fallback needed for judgment |
| observability | SDK log level; probabilities preserved | `decision.jev` control-bus event with geometry evidence (alignment, unfixable, residual) |
| invariants | ✗ repo facts leave the project; model opinion can contradict measured evidence | ✓ rules → Jev → LLM; bounded, audited, deterministic |
| director control | tune thresholds against a model that silently changes (`jev-latest` alias) | `phase.taste.mjs` — four dials, versionable in the repo |
| hands-off Pi sessions | needs key + network up; sign-up currently capped | works offline, always |

**Verdict:** for phase-pi's round-review decisions, the geometric kernel is the
better integration by every operational axis (deps, cost, latency, failure,
invariants, observability). Hosted Jev's advantage is content judgment — if we
ever want it, its clean slot is an **optional advisor** consulted only for
states the director asks to escalate, never in the default path.

## 4. Next (done in this change)
Geometric Jev integrated as part of the phase **skill** (what every Pi session
reads): see `skills/phase/SKILL.md` → "Jev — bounded judgment (zero-param
geometry)", the director's `phase.taste.mjs`, and the bench above.