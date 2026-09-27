# ISA-PRO

**The ISA: a caveman language for AI context to flow in and out.**

The LLM in this session is the processor — no SLM, no side model, no side
endpoint. It writes `ROUTE` / `GRANT` / `ALLOC`; the engine clamps it; the
harness confines and meters the work; the bus keeps the record.

```
isa begin "add rate limiting" [--asm "ALLOC TOKENS 8000 ..."] [--ceil K=V ...]
isa exec  "node --test test/"
isa status
isa end   --passed
```

While a run is active, the harness hook confines every write to the run's
sandbox and enforces the budgets — wall-time is engine-measured and
engine-killed, tool calls and tokens are metered for real, and an exceeded
line physically stops work.

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
| the language | `docs/isa.md`, `src/allocator.mjs` | parse, render, clamp |
| the engine | `src/engine.mjs`, `bin/` | runs, sandbox, wall enforcement, measurement |
| the hook | `.opencode/plugins/isa/` | native tools + metering + confinement + deny-mode |
| the bus | `src/bus.mjs` | the log — `control.ndjson` / `data.ndjson` |

The harness hook autoloads from `.opencode/plugins/`. For sessions outside
this repo, link or copy it into your own `~/.opencode/plugins/` (ISA-PRO is
built for the session LLM to use on itself — that is the point).

## What this is not

No tickets, no schedulers, no workers, no reviewers, no SLM, no pretend
physics. A prior version built all of that and failed; this keeps the three
ideas that work — the ISA, the clamp, the bus — and gives them teeth.

## License

MIT
