---
name: isa-pro
description: "Run work under ISA-PRO: isa_begin opens a sandboxed run; work is confined to the sandbox and recorded, nothing is budgeted or planned; isa_end closes the run with engine-measured actuals. The bus (.isa/bus) is the record."
---

# ISA-PRO

One idea: **a run is confined, recorded work.**

- **You are the processor.** There is no SLM, no side model, no side
  endpoint. You do the work in this session.
- **Nothing is planned.** `isa_begin` takes a task and opens a sandbox. No
  budgets, no grants, no scope commitment. The record shows what happened.
- **The sandbox is the boundary.** While a run is active, work is confined to
  the run's sandbox; writes outside it (and the ledger) are denied.
- **The bus is the log.** Context flows in and out as append-only events.
  Replay is truth.

## Tools (native to this harness)

| Tool | Does |
|---|---|
| `isa_begin` | start a run: task -> sandbox, the record begins |
| `isa_exec` | run a command inside the sandbox (wall-time bounded by a hard safety limit) |
| `isa_status` | the run facts: what is running, for how long, what it has done |
| `isa_end` | close the run — engine-measured wall and actuals recorded |
| `isa_emit` | append a signal to the bus |

CLI: `isa begin|exec|end|status|bus`.

## How to run work

1. `isa_begin` with the task. Nothing else is asked of you up front.
2. Do the work. `write`/`edit` go to the sandbox; `isa_exec` runs commands
   inside it. Writes outside the sandbox and the ledger (`.isa/`) are denied
   while the run is active.
3. `isa_end` with `passed: true` when done. The engine measures; do not
   self-report time.

## Rules

- **The sandbox is the boundary.** A run writes only inside its sandbox.
- **The bus is the record.** If it happened, it is on the bus.
- **Measured, never self-reported.** The engine reads the clock; you do not
  claim numbers.
- **No judgment in the runtime.** Facts in, facts out. Nothing is budgeted,
  nothing is denied beyond the sandbox and the wall limit.

The full design lives in `docs/isa.md`.
