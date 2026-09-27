---
name: isa-pro
description: "Use the ISA-PRO tools (isa_allocate, isa_bus) to assemble, clamp, and log ISA allocations. The ISA is a caveman language for AI context to flow in and out — LLM as processor, tokens as bytes. Emit ROUTE / GRANT / ALLOC lines; the runtime clamps them to ceilings; the bus keeps the log."
---

# ISA-PRO

One idea: **the ISA is a caveman language for AI context to flow in and out.**

- The LLM is the processor. Its context window is memory. Tokens are bytes.
- An ISA instruction is the smallest unit of meaning worth spending tokens on:
  one line, one decision, mechanically validatable.
- The LLM emits; the runtime clamps. No emitted value may exceed its ceiling.
- The bus is the log of record. Context flows in and out as append-only
  events. The bus is not a state machine.

## The language (v0)

```
ROUTE <agent>                the agent that runs the task
GRANT <tool>                 grant one tool (repeat for more)
ALLOC <RESOURCE> <integer>   budget for a resource, never above the ceiling
```

Resources: `CONTEXT_TOKENS`, `TOKENS`, `WALL_MS`, `TOOL_CALLS`,
`MONEY_MICROUNITS`, `HUMAN_ATTENTION_MICROUNITS`.

## Tools

| Tool | Does |
|---|---|
| `isa_allocate` | task -> ISA allocation (heuristic or model policy), clamped, logged to the bus |
| `isa_bus` | emit `sig.*` signals / read the tail of the control or data bus |

CLI: `isa alloc <task> [--policy model]`, `isa bus [emit|watch]`.

## Rules

- **Tokens are bytes.** Spend them like memory: the smallest instruction that
  expresses the decision; nothing decorative survives parsing.
- **The clamp is the dispose.** Model output is a proposal; ceilings are truth.
- **The bus is the log.** Every emit is replayable; nothing is a state machine.
- **No judgment in the runtime.** Assembly in, a validated allocation out.

The full design lives in `docs/isa.md`.
