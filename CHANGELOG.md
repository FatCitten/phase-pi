# Changelog

All notable changes, grouped by version. [SemVer](https://semver.org).

## [Unreleased] — roles & guardrails

Agents work only inside their assigned scope; the runtime enforces it.

- Scope guardrail in `TicketStore.claim`: out-of-scope direct requests are
  refused and recorded (`scope.violation`); pool scans filter silently.
- Delegation is the only path across scopes: `phase-role delegate T-XXXX
  --scope SCOPE` closes the ticket and opens a scoped child.
- Manager role (`phase-role manager`): performance → clamped budget
  recommendations (`manager.review` events); the allocator enforces ceilings.
- HR role (`phase-role hr`): read-only behavior audit with flags
  (`scope-discipline`, `flaky`, `retry-loop`); `hr.report` events.
- Worker scope grants: `--scope A,B` / `$PHASE_SCOPES`.
- Skill: "Roles & guardrails" section; `phase-role` registered as a bin.

## [2.2.0] — Jev as zero-param geometry · evidence verification · director taste

The hierarchy is now **RULES → JEV → VERIFY → LLM**: judgment is exact geometry
over the tickets themselves, completion is interrogated against real signals,
and the generative model only writes work. The human is a director, not a
manager — one small file of dials.

### Added
- **Jev — zero-param geometry** (`src/jev.mjs`): ticket states are phases on the
  unit circle (`passed→0`, `failed→π`); the round is the superposition; the
  cosine readout against the "done" anchor yields `goal_satisfied` as the
  **exact passed-fraction** (ZkBundle thesis: known structure → no model, 100%
  at step 0). Pure policy (`applyJevPolicy`) maps geometry to `YES/NO/UNKNOWN`
  with precedence: retry fixable failures → replace unfixable work → STOP clean.
  Review never calls a model; every decision lands as a `decision.jev` control
  event with the geometric evidence.
- **Verification** (`src/verify.mjs`): an exit code is not evidence. With
  `verify.beforeStop: 'git-evidence'` (the default), a passing ticket without a
  commit matching its objective flips to failed and the geometry re-derives
  truth: retry within the geometric budget → unfixable → the LLM writes
  replacement work. `TicketStore.unarchive()` restores archived done tickets for
  interrogation; attempt budgets persist across archives; orchestration never
  exits 0 with unproven work (exit 3 + FINAL count).
- **Taste — the director's dials** (`phase.taste.mjs`, `bin/phase-taste.mjs`):
  bands, retry budget, follow-up cap, verification dial, terminal rule. The
  `phase-taste` CLI validates and writes atomically (bad values are rejected,
  the file is never partially written); edits take effect on the NEXT review.
  Surfaced as the `phase_taste` tool and the `/phase taste` verb; ships in the
  package.
- **Session surface** (`src/session.mjs`, `/phase` command): repo-based
  `.phase/session.json` manifest surviving pi restarts, worker leases +
  heartbeats + stale-lease GC, archive-on-done compaction, `/phase
  [picker|chat|tickets|archive|taste]`, and the `phase_chat` PERMISSION gate —
  the LLM proposes, the deterministic runtime disposes.
- **Bench + docs**: `bench/jev-compare.mjs` + `results/jev-compare.json` — our
  measured numbers vs hosted Jev's published ones (85.4% on 10k text questions,
  ~80–210 ms/decision, $0.042/Mtok); architecture + integration-fit analysis in
  `docs/jev-architecture-comparison.md`; design notes in `docs/sessions.md`.
  The real-Jev arm activates with `TYPESAFE_API_KEY` when sign-ups reopen.

### Changed
- Provider: default brain is the light cloud model `glm-5.3-flash:cloud`;
  heavy local chat models are never loaded by default.
- Reconcile: `--all` audits archived done tickets too; the objective→evidence
  keyword is now a shared regex join, matching commit subjects that are the
  full objective even with interleaved stop-words.

### Fixed — stale-decision sweep (worker-flap incident, ABYSS 2026-09-25)
- Passive drain wait: a pool with nothing claimable no longer respawns workers
  every ~120 ms; it waits with exponential backoff (120 ms → 5 s cap) and emits
  one `pool.wait` per idle episode (~30 up/down pairs → 2/2 + 1 event).
- Dependencies resolve against archived tickets (a compacted dependency no
  longer blocks its dependent forever).
- Stale-lease GC: `reapStale()` is now called on attach and before lease
  registration, so dead workers cannot lease-park forever.
- Dead `llmProvider` export removed; repo-local `.phase` demo residue cleared.

### Tests
48 green (jev 17 · verification 10 · taste 5 · session/chat-gate/parsePlan 16).
Typecheck clean.

## [2.1.1] — install safety

Fix: re-running the launcher could brick a live Pi session (it re-ran `pi install`
and spawned a nested `pi`). Install is now idempotent and non-destructive.

- **Nested-Pi aware**: if run inside a live Pi session, phase stops — it never
  spawns a nested `pi` or reloads the running session.
- **Idempotent**: never re-registers phase if already present (matches abs/relative
  path, basename, or npm name).
- **Non-destructive**: backs up `~/.pi/agent/settings.json`, writes atomically
  (tmp + rename), never leaves a half-written config. Falls back to `pi install`
  only when needed — never during a live session.

## [2.1.0] — v1 Pi-native pivot

Phase becomes **Pi-only**. One entrypoint: run it → ensure Pi, install phase into
Pi, open Pi.

### Added
- `phase` launcher (`bin/phase.js`) + `phase` repo script + `install.sh` one-liner.
- All bootstrap Pi: installs Pi if missing, `pi install` phase, hands off.

### Removed
- MCP server, harness adapters, "works anywhere" CLI story. Pi-only now.
  Adapters come in later versions.

## [2.0.0] — 2026-09-20

Bundled Pi package + skill + engine.

### Added
- `phase_allocate`, `phase_orchestrate`, `phase_schedule`, `phase_bus_tickets`
  native tools + `phase` skill.
- Engine: alloc → orchestrate → review → RETRY/ADD/STOP; tickets (parallel /
  pipeline / DAG); offline heuristic fallback; `phase-chat`/`phase-chatroom`.
- Inherits Pi's live model via `src/provider.mjs` (`ctx.model` / `$PI_MODEL`).

### Fixed
- Reasoning models no longer empty: `max_tokens: 2048`.
- Chatroom TUI clamps rows; cursor never negative.

## [1.0.0] — 2026-09-15

Initial phase runtime (allocator + buses + heuristic/model allocation).
