# Changelog

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
