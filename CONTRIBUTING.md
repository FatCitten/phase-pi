# Contributing

Thanks for helping make **ISA-PRO** what it should be.

ISA-PRO is intentionally small: one engine (`src/engine.mjs`), one bus
(`src/bus.mjs`), one hook (`.opencode/plugins/isa/`). Keep it that way.

## What to preserve

- **Nothing is planned.** `isa begin` takes a task and nothing else. No
  budgets, no grants, no scope commitment. The record shows what happened.
- **The sandbox is the boundary.** A run writes only inside its sandbox.
  Confinement before convenience.
- **The bus is a log, not a state machine.** Anything may emit; everything is
  kept; replay is truth.
- **Measured, never self-reported.** The engine reads the clock; the hook
  reads the provider. Nothing trusts a claim.
- **Zero runtime dependencies.** Pure Node stdlib in `src/` and `bin/`.
- **No judgment in the runtime.** Facts in, facts out. No budgets, no
  scoring, no deny-mode.

## Change rules

- A new engine fact (a measured number) needs a `docs/isa.md` row and tests in
  `test/engine.test.mjs` before the engine writes it.
- A new bus event type is free — the bus is generic. Document the convention in
  `docs/isa.md` §6.
- Do not add state machines, reviewers, schedulers, workers, budgets, or
  allocations. Those were the failures the strips removed. If you think you
  need one, you are probably solving the wrong problem.
