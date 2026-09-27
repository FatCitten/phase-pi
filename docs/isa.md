# ISA-PRO — design

**A run is confined, recorded work.**

The allocation is gone: no `ROUTE`, no `GRANT`, no `ALLOC`, no budgets, no
ceilings, no clamp, no deny-mode. The system that remains is the ideas that
survived every strip: the sandbox, the run, the bus — and now the snapshot,
the cheapest way for a processor to read its environment.

## 1. The model

| term | meaning |
|---|---|
| run | one task, one sandbox, one record — `isa begin` to `isa end` |
| sandbox | the boundary — a run writes only inside its own directory |
| bus | the log of record — append-only control/data ndjson |
| meter | measurement written as data — never enforced |
| snapshot | repo state + diff as a compact token block — the cheapest read |

Consequences:

- **Nothing is planned.** `isa begin` takes a task and opens a sandbox. No
  scope is committed, no budget is proposed, no grant is declared. The record
  shows what happened, not what was intended.
- **The record is the truth.** The bus is a log, not a state machine. Anything
  may emit; everything emitted is kept; replay is truth.
- **The sandbox is the only boundary with teeth.** Writes outside the sandbox
  (and the ledger) are denied while a run is active. Wall-time on exec is
  bounded by a hard safety limit — runaway protection, not a budget.
- **Comprehension is cheap.** The snapshot reconstructs repo identity,
  structure, the last change-set, and uncommitted work in the smallest
  vocabulary that still says everything structural.

## 2. The engine

`isa begin` → `isa exec` (repeat) → `isa end`.

| command | does |
|---|---|
| `isa begin <task>` | open the per-run sandbox, write the runs pointer, log `run.begin` |
| `isa exec <cmd...>` | run a command inside the sandbox. Wall-clock is bounded by a hard safety limit (default 15 min, `--timeout` to lower it): the child is killed when the limit is gone. Output is captured to the run artifact and the data bus. |
| `isa end [--passed]` | the engine measures `wall_ms` itself, records the outcome, clears the pointer. Nothing is checked against anything. |
| `isa status` | the run facts: what is running, for how long, what it has done. |
| `isa state` | the comprehension snapshot (§3). |
| `isa bus [emit\|watch]` | the log. |

State: `.isa/runs/<id>/` (`actuals.json`, `sandbox/`, `artifact.log`) and
`.isa/runs/current.json` — the pointer the harness hook reads. No daemon, no
long-lived process. A new `begin` supersedes a stale pointer.

## 3. The snapshot

`isa state` emits one compact token block:

```
repo isa-pro v0.4.0 files 21 src 3 bin 7 doc 2 test 3 plug 1 cfg 1 sha ad1cd3f dirty 1
base ad1cd3f~1..HEAD +321 -709
f:src/engine.mjs +121 -110 +fn -fn +imp
f:src/allocator.mjs +0 -147 del
f:README.md +12 -4 +doc doc
w:src/engine.mjs M
```

| token | meaning |
|---|---|
| `repo <name> v<ver> files <n> [cat <n> ...] sha <s> dirty <n>` | identity, structure counts (`src bin doc test plug cfg other`, zero categories omitted), HEAD, uncommitted count |
| `base <ref>..HEAD +<a> -<r>` | the compared change-set and its line totals |
| `f:<path> +<a> -<d> [tokens]` | per-file diff: line counts + construct tokens |
| `w:<path> <XY>` | working tree status (`M` modified, `A` added, `D` deleted, `R` renamed, `?` untracked) |
| construct tokens | `add del +fn -fn +cls -cls +imp -imp +exp -exp +type -type +doc -doc cfg script doc` |

Options: `--base <ref>` picks the compared range (default `HEAD~1`),
`--compact` joins everything into one line, `--json` emits the structured
object. The vocabulary is the smallest set that reconstructs repo state +
diff; a new token must displace one, not join it. Fails closed outside a git
repo.

## 4. The sandbox

Every run writes only inside its sandbox. bwrap (bubblewrap) jail when
installed: read-only root, write only to the run's sandbox dir, fresh `/tmp`,
`/proc` and `/dev` from the host. Without bwrap: plain confinement — cwd
jailed, environment stripped, wall-time bounded. Never Docker-required.

## 5. The harness hook

`.opencode/plugins/isa/` — native to OpenCode. Inert until a run is active.

Native tools: `isa_begin`, `isa_exec`, `isa_end`, `isa_status`, `isa_state`,
`isa_emit` — the LLM drives the engine as first-class tools, not shell
escapes.

While a run is active:

| hook | behavior |
|---|---|
| `tool.execute.before` | real tool-call counting → actuals (record only) |
| `shell.create.before` | every shell command's cwd forced into the sandbox; timeout clamped to a flat safety ceiling |
| `permission.evaluate` | writes outside the sandbox and the ledger (`.isa/`) are denied |
| `session http.response` | real provider usage parsed from responses → token actuals (record only) |

Nothing here stops work. Measurement is data on the ledger and the bus;
the sandbox is the only boundary with teeth.

## 6. Measurement truth table

| fact | measured by | enforced by |
|---|---|---|
| `wall_ms` | the engine (clock, not self-report) | hard safety limit kills runaway exec |
| `exec_count` | the engine | — |
| sandbox confinement | — | bwrap jail + the hook's cwd jail + permission denies |
| `tool_calls` | the hook (before execution) | — |
| `tokens` | the hook (provider usage from HTTP responses) | — |

Honest gaps: providers streaming over WebSocket never hit `http.response` —
tokens are then recorded as absent, never faked. The ledger (`.isa/`) is
writable by design — it is the record.

## 7. The bus

Two append-only ndjson logs under `.isa/bus/`: `control.ndjson` (signals:
`run.begin`, `run.done`, `run.failed`, `run.killed`, notes) and `data.ndjson`
(payloads: exec records). Appends are O(1) (tail-read seq).

## 8. Design rules

Any new piece must satisfy all of these, or it does not ship:

1. **The bus is the record.** If it happened, it is on the bus.
2. **Measured, never self-reported.** The engine reads the clock; the hook
   reads the provider. Nothing trusts a claim.
3. **The sandbox is the boundary.** Confinement before convenience.
4. **Comprehension is cheap.** The snapshot stays at the smallest vocabulary
   that reconstructs state + diff.
5. **No judgment in the runtime.** Facts in, facts out. No budgets, no
   scoring, no deny-mode.
6. **Replayable.** The bus must reconstruct what happened exactly.

## 9. Open questions

- **Naming.** The allocation was the ISA (the instruction set). It is gone;
  the name may follow. Candidates for the next strip.
- **WS-provider token accounting.** A provider-specific hook, or an SDK-level
  usage callback, for streams that never produce HTTP responses.
- **Cross-repo runs.** One run, one repo today. Multi-repo work either needs
  multiple runs or a deliberate extension of the pointer.
- **Snapshot tiers.** Construct tokens are best-effort today; a second tier
  (changed symbol names) could deepen comprehension at a token cost.

## 10. Non-goals

- No tickets, queues, schedulers, or workers.
- No SLM, no side model, no side endpoint. One processor: the session LLM.
- No budgets, no allocation, no language, no deny-mode.
- No pretend physics. A sandbox, a record, a log, a snapshot.
- No state machines. If a behavior needs lifecycle, it goes on the bus as
  events, not into the runtime.
