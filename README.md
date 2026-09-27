# ISA-PRO

**The ISA: a caveman language for AI context to flow in and out.**

LLM as processor, tokens as bytes. You emit `ROUTE` / `GRANT` / `ALLOC` lines;
the runtime clamps them to ceilings; the bus keeps the log.

## Install

```bash
npm i -g isa-pro
```

Or run from source (Node >= 20):

```bash
git clone https://github.com/FatCitten/phase-pi.git
cd phase-pi
./isa --help
```

## Use

```bash
isa alloc "add rate limiting"                  # deterministic heuristic, offline
isa alloc "add rate limiting" --policy model    # the LLM emits the ISA, clamped
isa bus                                        # tail of the control bus
isa bus emit note repo=ready                   # append a signal
```

The allocation prints as JSON + ISA text and is logged to `.isa/bus/`
(`control.ndjson` for decisions, `data.ndjson` for payloads). The bus is a log,
not a state machine: anything may emit, everything is kept, replay is truth.

## What this is

`docs/isa.md` is the design — read that first. `src/allocator.mjs` assembles
and clamps; `src/bus.mjs` is the log; `bin/` are thin CLIs. `extensions/` and
`skills/` carry the minimal agent bridge; its final shape is a design-period
question.

## What this is not

No tickets, no schedulers, no workers, no reviewers, no state machines, no
pretend physics. A prior version (phase-pi) built all of that and failed; this
repo keeps the two ideas that worked — the ISA and the bus — and deletes the
rest.

## License

MIT
