# The ISA

**The ISA is a caveman language for AI context to flow in and out.**

Task execution with the LLM as processor and tokens as bytes. We design the
language *for* the LLM: every instruction's size and spec is fitted to the
tokens themselves.

**The processor is the LLM in the live session.** There is no SLM, no side
model, no side endpoint. The session LLM writes the assembly; the engine
clamps it; the harness confines and meters the work; the bus is the record.

## 1. The processor model

| machine term | ISA term |
|---|---|
| CPU | the LLM in this session |
| memory | the context window |
| byte | one token |
| instruction | one ISA line — a single decision, mechanically validatable |
| register | a resource: context, tokens, wall-clock, tool calls, money, attention |
| trap / fault | the clamp — an emitted value above its ceiling is rejected, not executed |
| jail | the sandbox — a run writes only inside its own directory |
| bus / port | the append-only event log the context flows in and out through |
| program counter | `isa status` — budget vs actuals so far |

Consequences:

- **The LLM does not hold state.** State is the log. The processor reads its
  inputs, emits its outputs, and both are appended to the bus. Anything the
  LLM must remember is re-read, not recalled.
- **The LLM proposes, the engine disposes.** The assembly is a proposal. The
  engine parses it, clamps it to ceilings, and logs what it did. A malformed
  or out-of-bounds emission never reaches execution.
- **One instruction, one decision.** No prose survives parsing. If a line does
  not carry a decision, it is noise spending bytes — the language makes it
  unrepresentable.

## 2. Why caveman

- **Token cost.** Every instruction costs tokens to emit and tokens to parse
  back into context. A word that carries no decision is a wasted byte. The
  language has no adjectives because adjectives are overhead.
- **Small-model reliability.** The language is sized to the weakest processor
  that must still get it right — proven: a 1.5B model emitted valid assembly
  at temperature 0. The session LLM has far more headroom than that.
- **Mechanical validation.** Fixed instruction names, one operand shape per
  instruction, integer resources. Validation is a lookup table, not a judgment
  call.
- **Compression without ambiguity.** The same line the LLM emits is the line
  the runtime re-feeds as context. Round-trip fidelity is exact because the
  format has nowhere to hide nuance.

## 3. The language — v0

One instruction per line. `;` starts an inline comment. Anything else is
ignored by the parser and is wasted bytes.

```
ROUTE <agent>                the agent that runs the task
GRANT <tool>                 grant one tool (repeat the line for more)
ALLOC <RESOURCE> <integer>   budget for a resource, never above the ceiling
```

Resources: `CONTEXT_TOKENS` (context window), `TOKENS` (generation), `WALL_MS`
(wall-clock), `TOOL_CALLS` (tool calls), `MONEY_MICROUNITS`, 
`HUMAN_ATTENTION_MICROUNITS`.

Semantics: `ROUTE` is last-wins; `GRANT` is a set; `ALLOC` is last-wins per
resource. Every emitted value is clamped to the caller's ceiling — the ceiling
is truth, the model's number is a request. Agents and tools outside the
allowlist never survive the clamp; a non-positive ceiling forces zero.

## 4. The engine

`isa begin` → `isa exec` (repeat) → `isa end`. The runtime side of the
contract:

| command | does |
|---|---|
| `isa begin <task> [--asm ...] [--ceil K=V ...]` | validate + clamp the allocation, open the per-run sandbox, write the runs pointer, log `run.alloc` + the ISA text |
| `isa exec <cmd...>` | run a command inside the sandbox. **Wall-clock is enforced by the engine**: the child gets only the remaining budget and is killed when it is gone. Output is captured to the run artifact and the data bus. |
| `isa end [--passed]` | the engine measures `wall_ms` itself, checks every budget line it has real numbers for, writes the outcome. Exit 0 clean, 2 over-budget. |
| `isa status` | the program counter: budget vs actuals, wall remaining, sandbox path. |
| `isa bus [emit\|watch]` | the log. |

State: `.isa/runs/<id>/` (`alloc.json`, `sandbox/`, `actuals.json`,
`artifact.log`) and `.isa/runs/current.json` — the pointer the harness hook
reads. No daemon, no long-lived process. A new `begin` supersedes a stale
pointer.

The allocation is authored by the session LLM (`author: session`) when
assembly is provided, else by the ceilings (`author: defaults`, context
halved). Offline always works — there is no model call to fail.

## 5. The sandbox

Every run writes only inside its sandbox. bwrap (bubblewrap) jail when
installed: read-only root, write only to the run's sandbox dir, fresh `/tmp`,
`/proc` and `/dev` from the host. Without bwrap: plain confinement — cwd
jailed, environment stripped, wall-time enforced. Never Docker-required.

The sandbox is real from day one. The harness hook extends it upward.

## 6. The harness hook

`.opencode/plugins/isa/` — native to OpenCode. Inert until a run is active.

Native tools: `isa_begin`, `isa_exec`, `isa_end`, `isa_status`, `isa_emit` —
the LLM drives the engine as first-class tools, not shell escapes.

Enforcement while a run is active:

| hook | enforcement |
|---|---|
| `tool.execute.before` | real tool-call counting → actuals; over `TOOL_CALLS` → deny-mode |
| `shell.create.before` | every shell command's cwd forced into the sandbox; timeout clamped to the remaining `WALL_MS` |
| `permission.evaluate` | writes outside the sandbox and the ledger (`.isa/`) are denied; in deny-mode all work actions are denied |
| `session http.response` | real provider usage (`prompt_tokens`/`completion_tokens`) parsed from responses → token actuals; over `TOKENS` → deny-mode |

Deny-mode is physical: the permission hook denies work actions, `isa_exec`
refuses, and `sig.run.budget.exceeded` is written to the bus before the wall
comes down. The LLM then must `isa_end`.

## 7. Enforcement truth table

| line | measured by | enforced by |
|---|---|---|
| `WALL_MS` | the engine (clock, not self-report) | the engine kills the child; the hook clamps shell timeouts |
| sandbox confinement | — | bwrap jail + the hook's cwd jail + permission denies |
| `TOOL_CALLS` | the hook (before execution) | the hook's deny-mode |
| `TOKENS` | the hook (provider usage from HTTP responses) | the hook's deny-mode |
| `MONEY_MICROUNITS`, `HUMAN_ATTENTION_MICROUNITS` | recorded, unenforced | — |

Honest gaps: providers streaming over WebSocket never hit `http.response` —
tokens are then recorded as absent, never faked. The ledger (`.isa/`) is
writable by design — it is the record.

## 8. The bus

Two append-only ndjson logs under `.isa/bus/`: `control.ndjson` (decisions and
signals) and `data.ndjson` (payloads: ISA text, exec output, artifacts).
Appends are O(1) (tail-read seq). The bus is a log, not a state machine:
anything may emit, everything is kept, replay is truth.

## 9. Design rules

Any new instruction must satisfy all of these, or it does not ship:

1. **One line, one decision.**
2. **Parseable by a lookup table.** No nesting, no prose operands.
3. **Emittable by a small model, cold.** If a 1B-class model cannot emit it
   correctly at temperature 0, the instruction is too big.
4. **Clampable.** Every operand has a ceiling or an allowlist the engine can
   enforce mechanically.
5. **Replayable.** The instruction plus the bus tail must reconstruct the
   decision exactly.

## 10. Design period — open questions

- **Instruction set growth.** Candidates: `FORK`, `RUN`, `GATE`, `RELEASE`,
  `HALT` — each must pass §9 first.
- **WS-provider token accounting.** A provider-specific hook, or an SDK-level
  usage callback, for streams that never produce HTTP responses.
- **Cross-repo runs.** One run, one repo today. Multi-repo work either needs
  multiple runs or a deliberate extension of the pointer.
- **Money/attention semantics.** What actually consumes `MONEY_MICROUNITS`
  and `HUMAN_ATTENTION_MICROUNITS` inside a harness, and who meters them.

## 11. Non-goals

- No tickets, queues, schedulers, or workers.
- No SLM, no side model, no side endpoint. One processor: the session LLM.
- No judgment in the runtime. Assembly in, a validated allocation out.
- No pretend physics. A language, a clamp, a sandbox, a log.
- No state machines. If a behavior needs lifecycle, it goes on the bus as
  events, not into the runtime.
