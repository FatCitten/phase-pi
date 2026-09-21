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
