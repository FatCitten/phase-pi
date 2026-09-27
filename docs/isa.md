# The ISA

**The ISA is a caveman language for AI context to flow in and out.**

Task execution with the LLM as processor and tokens as bytes. We design the
language *for* the LLM: every instruction's size and spec is fitted to the
tokens themselves.

This document is the design. The code exists to serve it — `src/allocator.mjs`
assembles and clamps the ISA, `src/bus.mjs` is the I/O channel, `bin/` are thin
CLIs, and everything else in this repo is scaffolding around those two ideas.

## 1. The processor model

The LLM is a CPU. Its context window is memory. Tokens are bytes. An ISA
instruction is the smallest unit of meaning worth spending tokens on.

| machine term | ISA term |
|---|---|
| CPU | the LLM |
| memory | the context window |
| byte | one token |
| instruction | one ISA line — a single decision, mechanically validatable |
| register | a resource: context, tokens, wall-clock, tool calls, money, attention |
| trap / fault | the clamp — an emitted value above its ceiling is rejected, not executed |
| bus / port | the append-only event log the context flows in and out through |
| program counter | the bus tail — where the next read starts |

Consequences the model is built on:

- **The LLM does not hold state.** State is the log. The processor reads its
  inputs, emits its outputs, and both are appended to the bus. Anything the
  LLM must remember is re-read, not recalled.
- **The LLM proposes, the runtime disposes.** Model output is a proposal. The
  runtime parses it, clamps it to ceilings, and logs what it did. A malformed
  or out-of-bounds emission never reaches execution.
- **One instruction, one decision.** No prose survives parsing. If a line does
  not carry a decision, it is noise spending bytes — the language makes it
  unrepresentable.

## 2. Why caveman

The language is deliberately blunt, and that is the design:

- **Token cost.** Every instruction costs tokens to emit and tokens to parse
  back into context. A word that carries no decision is a wasted byte. The
  language has no adjectives because adjectives are overhead.
- **Small-model reliability.** A tiny model can emit `ALLOC WALL_MS 60000`
  reliably. It cannot reliably emit prose that a parser must then interpret.
  The language is sized to the weakest processor that must still get it right.
- **Mechanical validation.** A caveman language is trivially checkable: fixed
  instruction names, one operand shape per instruction, integer resources.
  Validation is a lookup table, not a judgment call.
- **Compression without ambiguity.** The same line that the model emits is the
  line the runtime re-feeds as context. Round-trip fidelity is exact because
  the format has nowhere to hide nuance.

## 3. The language — v0

One instruction per line. `;` starts an inline comment. Anything else is
ignored by the parser and is wasted bytes.

```
ROUTE <agent>                the agent that runs the task
GRANT <tool>                 grant one tool (repeat the line for more)
ALLOC <RESOURCE> <integer>   budget for a resource, never above the ceiling
```

Resources:

| tag | meaning | unit |
|---|---|---|
| `CONTEXT_TOKENS` | context window the run may consume | tokens |
| `TOKENS` | generation budget | tokens |
| `WALL_MS` | wall-clock budget | milliseconds |
| `TOOL_CALLS` | tool-call budget | calls |
| `MONEY_MICROUNITS` | spend budget | millionths of a unit |
| `HUMAN_ATTENTION_MICROUNITS` | human attention budget | millionths of a unit |

Semantics:

- `ROUTE` is last-wins. `GRANT` is a set — duplicates collapse. `ALLOC` is
  last-wins per resource.
- Every emitted value is **clamped to the caller's ceiling**. The ceiling is
  truth; the model's number is a request. No emitted value may exceed its
  ceiling, and a non-positive ceiling forces zero (money and attention are
  typically zero).
- Agents and tools outside the caller's allowlist never survive the clamp.
  The model can ask for anything; it receives only what is granted.

## 4. The bus — context in and out

The bus is how context flows into the processor and out again. Two append-only
ndjson logs under `.isa/bus/`:

- `control.ndjson` — decisions and signals: `sig.alloc.decision`, any `sig.*`
  a participant emits.
- `data.ndjson` — payloads: the emitted ISA text, actuals, artifacts.

Rules:

- **The bus is a log, not a state machine.** No lifecycle types, no statuses,
  no transitions. Anything may emit; everything emitted is kept. Replay the
  log and you have the full machine truth.
- **Appends are O(1).** Sequence numbers are assigned by tail-read, so a bus
  that grows never slows the writes.
- **The bus is the only shared memory.** Workers, humans, and the processor
  coordinate by reading the tail and appending signals. Nothing else is shared.

## 5. The contract

```
caller ── task + ceilings ──▶ assembler ── ISA text ──▶ clamp ──▶ log
                              (heuristic)     ▲
                              (model) ────────┘ proposal, clamped
```

1. A caller supplies a task, an allowlist, and ceilings.
2. The assembler produces an ISA allocation — deterministically (heuristic,
   offline) or by asking the model to emit assembly (streamed, temperature 0).
3. Every value is clamped to the ceilings. The result is the *validated
   allocation*, rendered back to ISA text.
4. The decision is logged on the control bus, the ISA on the data bus. Every
   emit is replayable.

The heuristic exists so the contract holds offline: same shape, same clamp,
budgets from the ceilings with the context halved (smallest context likely to
finish). It is the fallback, not the product — the product is the model
emitting the caveman language and the runtime refusing anything out of bounds.

## 6. Design rules

Rules for extending the language. Any new instruction must satisfy all of
them, or it does not ship:

1. **One line, one decision.** If an instruction needs a second line to mean
   something, it is two instructions.
2. **Parseable by a lookup table.** No nesting, no prose operands, no
   punctuation beyond `;`.
3. **Emittable by a small model, cold.** If a 1B-class model cannot emit it
   correctly at temperature 0, the instruction is too big.
4. **Clampable.** Every operand has a ceiling or an allowlist the runtime can
   enforce mechanically.
5. **Replayable.** The instruction plus the bus tail must reconstruct the
   decision exactly.

## 7. Design period — open questions

Deferred deliberately. Each gets its own note before any code:

- **Enforcement.** The ISA is currently a validated contract; nothing executes
  it. Who enforces (a wrapper runtime, the consuming agent), and how do
  actuals flow back onto the bus?
- **Instruction set growth.** Candidates from the old seed's output set:
  `FORK`, `RUN`, `GATE`, `RELEASE`, `HALT` — each must pass §6 first.
- **Bus topology.** Is control/data split the right cut, or should payloads
  be content-addressed with the control log referencing them?
- **Agent integration shape.** The extension currently registers two thin
  tools (`isa_allocate`, `isa_bus`). Whether the ISA becomes a first-class
  protocol inside the agent is the design period's main question.

## 8. Non-goals

- No tickets, queues, schedulers, or workers.
- No judgment in the runtime. The ISA has no reviewer — assembly in, a
  validated allocation out.
- No pretend physics. The language is a format and a clamp, nothing more.
- No state machines. If a behavior needs lifecycle, it goes on the bus as
  events, not into the runtime.
