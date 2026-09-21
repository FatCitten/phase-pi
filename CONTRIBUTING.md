# Contributing

Thanks for helping make **phase-pi** a better servant for the Pi agent (and every
agent that runs it).

Phase is intentionally small: a bounded coordination suite that turns human
intent into an allocation plan and coordinates it. Keep it that way.

## What to preserve

- **Human intent dominates.** The allocator must never invent project truth.
- **Bounded by default.** Every model allocation decision is clamped to the
  caller's declared ceiling — the LLM can never overspend.
- **Project facts stay in the project.** The model sees allocation state, never
  source or secrets.
- **Zero runtime dependencies.** Pure Node stdlib.
- **Heuristic fallback always works.** If the model endpoint is unavailable,
  allocation must still succeed offline.
- **Portable root resolution.** The bundled Pi extension must keep working no
  matter where `pi install` places the package (see `extensions/phase.ts`).

## Development

```bash
npm install
npm run typecheck      # validates the bundled Pi extension types
npm run smoke          # CLI allocator + MCP server, offline
```

## Changes requiring explicit attention

- Changes to allocation-state encoding, the architecture seed/invariants, the
  Phase ISA vocabulary, or budget clamping semantics should be explicit and tested.
- Any new orchestration/ticketing behavior must degrade gracefully when the
  model endpoint is unavailable.
- The `phase_allocate` tool signature and default budget belong to the public
  contract — treat changes as backwards-incompatible.

## Testing without the network

```bash
node bin/phase-alloc.mjs "task" --repo . --policy heuristic   # offline, always works
node bin/phase-orchestrate.mjs "goal" --repo . --dry-run      # decompose + report only
```

Model-path behavior can be tested against a mock OpenAI-compatible endpoint.

## Commit

Use conventional-commit style (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
Keep commits focused and the history linear (squash before merge).
