# ISA-PRO

**A run is confined, recorded work.**

No budgets, no allocation, no language, no deny-mode. The LLM in this session
does work inside a per-run sandbox; the engine confines it and bounds wall-time
with a hard safety limit; measurement is record-only; the bus is the log of
record.

```
isa begin "add rate limiting"      # a sandbox plus a record — nothing planned
isa exec  "node --test test/"
isa status                          # the run facts
isa end   --passed
isa bus                             # the record
```

While a run is active, the harness hook confines every write to the run's
sandbox. Nothing is budgeted and nothing is enforced beyond the sandbox and
the wall limit — wall-time and exec count are measured by the engine, tool
calls and tokens are metered by the hook when real numbers exist, and all of
it is written to the bus as data, never as a stop.

## Install

```bash
npm i -g isa-pro
```

Or run from source (Node >= 20, bwrap optional but recommended):

```bash
git clone https://github.com/FatCitten/phase-pi.git
cd phase-pi
./isa --help
```

## The pieces

| piece | where | role |
|---|---|---|
| the engine | `src/engine.mjs`, `bin/` | runs, sandbox, wall safety limit, measurement |
| the hook | `.opencode/plugins/isa/` | native tools + confinement + record-only metering |
| the bus | `src/bus.mjs` | the log — `control.ndjson` / `data.ndjson` |

The harness hook autoloads from `.opencode/plugins/`. Its one dependency
(`@opencode/plugin`) is a devDependency — `npm install` in this repo
provisions it. For sessions outside this repo, link or copy the plugin dir
into your own `~/.opencode/plugins/` and keep the dependency installed where
the hook resolves it.

## What this is not

No tickets, no schedulers, no workers, no reviewers, no SLM, no budgets, no
pretend physics. A prior version built all of that and failed; this keeps the
two ideas that work — the sandbox and the bus — and drops the rest.

## License

MIT
