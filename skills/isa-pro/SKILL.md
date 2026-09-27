---
name: isa-pro
description: "Run work under the ISA: isa_begin opens a sandboxed, budgeted run; you are the processor and write ROUTE / GRANT / ALLOC assembly yourself; the engine clamps, the harness confines and meters, and isa_end closes the run with engine-measured actuals. The bus (.isa/bus) is the record."
---

# ISA-PRO

One idea: **the ISA is a caveman language for AI context to flow in and out.**

- **You are the processor.** The LLM in this session writes the assembly.
  There is no SLM, no side model, no side endpoint.
- **The engine disposes.** Every emitted value is clamped to the caller's
  ceiling. Malformed or out-of-bounds assembly never reaches execution.
- **The harness is the jailer.** While a run is active, work is confined to
  the run's sandbox, tool calls and tokens are metered for real, and a budget
  line exceeded physically stops work (deny-mode).
- **The bus is the log.** Context flows in and out as append-only events.
  Replay is truth.

## The language (v0)

```
ROUTE <agent>                the agent that runs the task
GRANT <tool>                 grant one tool (repeat for more)
ALLOC <RESOURCE> <integer>   budget for a resource, never above the ceiling
```

Resources: `CONTEXT_TOKENS`, `TOKENS`, `WALL_MS`, `TOOL_CALLS`,
`MONEY_MICROUNITS`, `HUMAN_ATTENTION_MICROUNITS`.

## Tools (native to this harness)

| Tool | Does |
|---|---|
| `isa_begin` | start a run: task + optional asm + ceilings -> validated allocation, sandbox, metering on |
| `isa_exec` | run a command inside the sandbox (wall-time enforced by the engine) |
| `isa_status` | the program counter: budget vs actuals, wall remaining |
| `isa_end` | close the run — engine-measured wall, budget checks, exit 0 clean / 2 over |
| `isa_emit` | append a signal to the bus |

CLI: `isa begin|exec|end|status|bus`.

## How to run work

1. `isa_begin` with the task. Write the ISA yourself (`asm`) when you want
   fewer tokens, tighter walls, or a narrower tool set — the clamp enforces
   the ceilings either way.
2. Do the work. `write`/`edit` go to the sandbox; `isa_exec` runs commands
   inside it. Writes outside the sandbox and the ledger (`.isa/`) are denied
   while the run is active.
3. `isa_end` with `passed: true` when done. The engine measures; do not
   self-report time.

## Rules

- **Tokens are bytes.** Spend them like memory: the smallest instruction that
  expresses the decision.
- **The clamp is the dispose.** Model output is a proposal; ceilings are truth.
- **The sandbox is the boundary.** A run writes only inside its sandbox.
- **Deny-mode is physical.** Over a budget line, work stops. End the run and
  start a new one with a wider allocation if the task deserves it.
- **No judgment in the runtime.** Assembly in, a validated allocation out.

The full design lives in `docs/isa.md`.
