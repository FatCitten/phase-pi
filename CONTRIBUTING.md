# Contributing

Thanks for helping make **ISA-PRO** what it should be.

ISA-PRO is intentionally small: one language (`docs/isa.md`) and two modules
(`src/allocator.mjs`, `src/bus.mjs`). Keep it that way.

## What to preserve

- **Tokens are bytes.** Every instruction is the smallest unit of meaning worth
  spending tokens on. If a proposed instruction needs prose to be understood,
  it does not ship.
- **The clamp is the dispose.** Every model-emitted value is clamped to the
  caller's ceiling. The model proposes; the runtime disposes.
- **The bus is a log, not a state machine.** Anything may emit; everything is
  kept; replay is truth.
- **Zero runtime dependencies.** Pure Node stdlib in `src/` and `bin/`.
- **Heuristic fallback always works.** If the model endpoint is unavailable,
  allocation must still succeed offline.
- **Design rules first.** New language instructions must pass every rule in
  `docs/isa.md` §6 before any code.

## Change rules

- A new instruction changes the language. It needs a `docs/isa.md` section and
  tests in `test/isa.test.mjs` before the parser accepts it.
- A new bus event type is free — the bus is generic. Document the convention in
  `docs/isa.md` §4.
- Do not add state machines, reviewers, schedulers, or workers. Those were the
  failure the strip removed. If you think you need one, you are probably
  solving the wrong problem.
