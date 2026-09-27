# phase · Pi

Plan intent. Run agents. Only in **Pi**.

`phase` is a Pi package. Run it → Pi installs phase → phase works.

```
curl -fsSL https://raw.githubusercontent.com/FatCitten/phase-pi/main/install.sh | bash
```

Or local:

```bash
git clone https://github.com/FatCitten/phase-pi.git
cd phase-pi
./phase
```

Or npm:

```bash
npm i -g phase-pi
phase
```

All do the same: **ensure Pi, install phase, open Pi**. Nothing else.

**Safe to re-run.** Idempotent — if phase is already installed it changes
nothing. Non-destructive — backs up Pi settings, writes atomically, and never
spawns a nested Pi (so it won't brick your live session).

## What you get

Inside Pi, phase adds 4 tools + a skill:

| Tool | Does |
| --- | --- |
| `phase_allocate` | Task → plan (route, tools, budget, ISA) |
| `phase_orchestrate` | Goal → tickets → workers → review → RETRY/ADD/STOP |
| `phase_schedule` | Run tickets (parallel / pipeline / DAG) |
| `phase_bus_tickets` | Live ticket status |

Plus `/phase` skill: work within granted tools & budget.

The brain is **your model** — Pi's live model & endpoint.

```
phase_allocate "add rate limiting"
phase_orchestrate "ship offline auth"
```

## Round review with Jev (zero-param geometry)

`phase_orchestrate`'s round review is **exact geometry over the tickets
themselves** — no model, no network, no API key:

ticket states are phases on a circle (`passed→0`, `failed→π`); the round is their
superposition; the readout against the "done" anchor yields `goal_satisfied` as
the **exact passed-fraction**. All done → STOP; fixable failures → RETRY;
unfixable failures → the generative model WRITES replacement work; 50/50 →
honestly ambiguous.

The opinionated parts are dials, not weights — edit `phase.taste.mjs`:

```js
export const TASTE = {
  bands: { yes: 0.72, no: 0.28 },   // alignment → YES / NO / UNKNOWN
  retry: { maxAttempts: 2 },        // geometric retry budget per ticket
  followup: { maxPerRound: 3 },     // replacement work the LLM may write
  stop: { requireAllDone: true },   // false = "ship with known-broken residue"
};
```

Architecture comparison against hosted Jev's published numbers:
`docs/jev-architecture-comparison.md` · bench: `node bench/jev-compare.mjs`.

## Why Pi-only

Phase is the coordination servant. Pi is the agent. One pairing, one target.
No CLI-to-the-world, no MCP, no adapters. Later versions may grow them.

## Backend

`bin/` + `src/` power the tools. Internal. Not a product.
`examples/smoke-test.sh` checks them, offline:

```bash
bash examples/smoke-test.sh
```

## Docs

- [INSTALL](README.md) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) · [CHANGELOG](CHANGELOG.md)

## License

[MIT](LICENSE)
