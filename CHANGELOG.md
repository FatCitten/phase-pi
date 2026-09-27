# Changelog

## 0.4.0 — 2026-09-27 — the comprehension snapshot

The next piece: a compact vocabulary for repo state + diff, so the session
LLM can comprehend its environment in a minimum of tokens.

- **`isa state`** (`bin/isa-state.mjs`): one token block — repo identity and
  structure counts, the last change-set per file with construct tokens
  (`add del +fn -fn +cls -cls +imp -imp +exp -exp +type -type +doc -doc cfg
  script doc`), and uncommitted work (`w:path XY`). `--base` picks the
  compared ref, `--compact` joins into one line, `--json` emits the
  structured object. Fails closed outside a git repo.
- **Native tool `isa_state`** in the hook: the snapshot as a first-class tool,
  the cheapest read of the environment.
- **Tests** (`test/state.test.mjs`): a throwaway git repo exercises identity,
  structure counts, diff tokens (add/del/fn/doc), `--base`, work statuses,
  compact rendering, and the no-git failure.

## 0.3.0 — 2026-09-27 — the allocation is gone

The allocation was the last piece of planning theater. `ROUTE` / `GRANT` /
`ALLOC`, budgets, ceilings, the clamp, over-budget checks, and deny-mode are
all deleted. What remains: a run is confined, recorded work.

- **The language is deleted** (`src/allocator.mjs`, `test/isa.test.mjs`).
  `isa begin` takes a task and nothing else. Nothing is planned up front.
- **The engine** (`src/engine.mjs`): `begin` opens the sandbox and logs
  `run.begin`; `exec` runs inside the sandbox under a hard wall safety limit
  (runaway protection, not a budget); `end` measures and records, checking
  nothing; `status` reports run facts.
- **The hook** (`.opencode/plugins/isa/`): confinement stays (shell cwd
  jailed to the sandbox, writes outside sandbox + ledger denied). Deny-mode
  and budget-exceeded signals are gone. Tool-call and token metering are
  record-only — written to the ledger and the bus, never enforced.
- **The bus** signal types change: `run.begin` / `run.done` / `run.failed` /
  `run.killed` on control; `run.exec` on data. `run.alloc` / `run.isa` /
  `run.budget.exceeded` are gone.
- Fix carried from 0.2: the hook spawns a real Node runtime (`$NODE` or
  `node`), not `process.execPath` — inside the OpenCode host that is the
  compiled opencode binary and rejected every `isa_*` flag.

Naming is an open question: the allocation *was* the ISA. The name may follow
in a later strip.

## 0.2.0 — 2026-09-27 — the processor is the session LLM

The SLM is gone. It was the root problem wearing a new costume: the brain was
still a side model, side endpoint, side process — the session LLM stayed
outside its own language.

- **The session LLM is the processor.** It writes the assembly itself. No
  SLM, no provider resolution, no API keys, no SSE, no retry/backoff, no
  JSON salvage, no fallback policy — all deleted (`src/provider.mjs`,
  `--policy model`, the model path in the allocator).
- **The engine** (`src/engine.mjs`, `isa begin|exec|end|status`): per-run
  state in `.isa/runs/<id>/`, a runs pointer, engine-measured wall-time,
  engine-killed overruns, budget checks at end.
- **The sandbox is real from day one**: bwrap jail (read-only root, write
  only to the run sandbox, fresh /tmp) when bubblewrap is installed, plain
  confinement otherwise.
- **The harness hook** (`.opencode/plugins/isa/`): native tools
  (`isa_begin`, `isa_exec`, `isa_end`, `isa_status`, `isa_emit`) plus
  enforcement — real tool-call counting, shell cwd jailed to the sandbox,
  write-denies outside sandbox + ledger, real token usage parsed from
  provider responses, and physical deny-mode when a budget line is exceeded.
- Pi bridge (`extensions/`, typebox, `@earendil-works/*`) deleted. The
  harness is OpenCode now.

## 0.1.0 — 2026-09-27 — the strip

ISA-PRO is born out of phase-pi's failure. Everything deleted except the two
ideas that worked:

- **The ISA** — `ROUTE` / `GRANT` / `ALLOC`, parsed, validated, clamped to
  caller ceilings.
- **The bus** — append-only control/data ndjson logs with O(1) tail seq.

Deleted: the ticket system, the worker pool and its demo job, the
orchestrator, the "Jev" zero-param geometry reviewer, the hashed state-vector
features, the allocator seed/priors theater, the session manifest and leases,
the roles, the chat flows, git-evidence verification, the taste dials, the
benches and results, and the lessons ledger.
