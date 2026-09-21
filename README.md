<div align="center">

# phase · for the Pi agent

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![npm](https://img.shields.io/npm/v/phase-pi)](https://www.npmjs.com/package/phase-pi)
[![CI](https://github.com/FatCitten/phase-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/FatCitten/phase-pi/actions)
[![pi package](https://img.shields.io/badge/pi-package-6a4caf)](https://pi.dev/packages)

**Turn human intent into a bounded plan — and run it with concurrent agents.**

A *servant-shaped* coordination suite for human ↔ AI agentic work. A language
model — small (SLM) or large (LLM) — is the **brain**: it allocates, plans,
chats, and drives concurrent workers through a control + data bus and an atomic
ticket system.

Bundled for the **Pi agent**, yet a plain **npm-installable CLI** that works in
any terminal or MCP client.

[Install](#install) · [Quick start](#quick-start) · [Pi integration](#pi-integration) ·
[MCP server](#mcp-server) · [CLI reference](#cli) · [Benchmarks](#benchmarks)

</div>

---

## Highlights

- **One intent → bounded plan.** `phase_allocate` returns route / tools / budget
  (context tokens, wall time, tool calls) plus a human-readable **Phase ISA**.
- **Multi-ticket orchestration.** `phase-orchestrate` decomposes a goal →
  schedules dependency-aware tickets (DAG) across a concurrent worker pool →
  reviews outcomes and **RETRY / ADD / STOP**.
- **Uses *your* model.** When run inside Pi it inherits the live chat model &
  endpoint (`ctx.model` / `$PI_MODEL`), so the allocation brain is the same LLM
  you're already talking to. Pin a different brain with `PHASE_SLM_MODEL` /
  `PHASE_SLM_BASE_URL`.
- **Always works offline.** Model unavailable? Everything falls back to a
  deterministic heuristic — `allocation_policy: "heuristic-fallback"`.
- **Bounded & safe.** Every model decision is clamped to the caller's ceiling.
  Project source and secrets never leave the repo or reach the model endpoint.
- **Zero runtime dependencies.** Pure Node stdlib — runs anywhere Node ≥ 20 does.

## What it is

`phase` is a small suite of commands that coordinate real agentic work:

| Command | What it does |
| --- | --- |
| `phase` (phase-alloc) | Turn one task + repo into a bounded allocation plan (route / tools / budget / Phase-ISA). |
| `phase-orchestrate` | LLM/SLM *brain*: decompose goal → schedule tickets → review → RETRY/ADD/STOP. |
| `phase-schedule` / `phase-worker` | Drain-loop scheduler (independent / `--pipeline` / `--dag`) + atomic per-ticket workers with **fresh context**. |
| `phase-chat` / `phase-chatroom` | Stateful human↔AI coordination emitting `TICKET`/`DEPENDS`/`CONSTRAINT`/`QUESTION`/`PERMISSION`/`RUN`. |
| `phase-bus` | Observe control + data buses (lifecycle signals, conversation logs, artifacts) and the ticket store. |
| `phase-mcp` | MCP (Model Context Protocol) server over stdio exposing `phase_allocate`. |

All coordination state lives under `.phase/` (event-sourced buses + atomic
ticket store). Project source and secrets never leave the repo.

## Install

**Option A — install from source (recommended, self-contained):**

```bash
cd phase-pi && npm install -g .
phase "fix the failing auth tests" --repo . --policy heuristic
```

**Option B — run directly (no install):**

```bash
node bin/phase-alloc.mjs "fix the failing auth tests" --repo . --policy heuristic
```

**Option C — npm install** (name `phase-pi`):

```bash
npm install -g phase-pi
phase "add rate limiting to the API" --repo .
```

## Quick start

```bash
# Heuristic allocation — offline, always works
phase "fix the failing auth tests" --repo . --policy heuristic

# Let the model decide (OpenAI-compatible endpoint; Ollama default when in Pi)
phase "refactor the schema layer" --repo . --model qwen2.5:1.5b

# Read intent from stdin or a file
echo "add rate limiting to the API" | phase - --repo .
phase task.md --repo .

# Human-readable Phase ISA plan only
phase "fix the failing auth tests" --isa
```

Sample output (JSON plan):

```json
{
  "schema": "phase-alloc-servant-v1",
  "objective": "fix the failing auth tests",
  "allocation_policy": "model",
  "fiber": { "id": "F1", "objective": "...", "tools": ["read","edit","test","bash"] },
  "allocation": {
    "agent": "auto",
    "tools": ["read", "edit", "test", "bash"],
    "budget": { "context_tokens": 6600, "tokens": 24000, "wall_ms": 900000, "tool_calls": 40 }
  },
  "isa": "ROUTE auto\nALLOC CONTEXT_TOKENS 6600\n..."
}
```

## Multi-ticket orchestration

The **SLM/LLM is the orchestrator.** Give it a human goal and it drives the whole
loop autonomously:

```bash
# Decompose -> schedule -> review -> RETRY/ADD/STOP (offline fallback included)
phase-orchestrate "Build a small lib w/ core api wired to login" --repo . --rounds 3 --count 4

# Run a real command per ticket
phase-orchestrate "ship offline auth with tests" --repo . --exec "npm test"

# Lay out tickets yourself
phase-schedule "add a --json flag" "document streaming" --repo . --count 4   # parallel
phase-schedule --pipeline "api" "tests" "docs" --repo .                       # linear chain
phase-schedule --dag graph.json --exec "npm test"                            # arbitrary DAG

# Observe the coordination
phase-bus bus --follow --repo .          # stream control events
phase-bus tickets --repo .               # list tickets + status
phase-bus ticket T-XXXX1234 --repo .     # inspect one ticket
```

> **Why fresh-context is the point:** each ticket is worked by its *own* fresh
> allocation (new repo snapshot + nonce + independent budget). Workers never
> share state, so they scale indefinitely without contaminating each other.

## Pi integration

This package ships as a **Pi package** (`pi-package` keyword): install it and the
four native tools + skill light up automatically — no shelling out.

```bash
pi install git:github.com/FatCitten/phase-pi@v2.0.0
```

This registers:

- **`phase_allocate`** — single task → bounded plan. Call before starting work.
- **`phase_orchestrate`** — the LLM brain decomposes → schedules → reviews.
- **`phase_schedule`** — lay out tickets and run them.
- **`phase_bus_tickets`** — live status of a repo's ticket store.
- **`/phase` skill** — teaches the agent to work within granted tools/budget.

These native tools inherit the **live model & provider** of the current chat
(`ctx.model` / `$PI_MODEL` via `src/provider.mjs`), so the allocator/orchestrator
brain is whatever model you're already talking to — e.g. an Ollama model on
`http://127.0.0.1:11434/v1`. Set `PHASE_SLM_MODEL` / `PHASE_SLM_BASE_URL` to pin
a different brain; switch the chat model with `/model` and phase follows.

The project also includes a standalone **MCP server** for any MCP-aware client:

```bash
npm run mcp            # node src/mcp-server.mjs  (JSON-RPC/stdio)
npm run mcp:ping       # handshake + tools/list + tools/call smoke test
# register examples/phase-mcp-tool.json statically, or via server discovery
```

## CLI

```
--repo <path>     repo/git root to coordinate      (default: cwd)
--policy model|h  model (SLM) or heuristic         (default: model)
--base-url <url>  OpenAI-compatible endpoint      (default: $PHASE_SLM_BASE_URL or pi/Ollama 11434)
--model <id>      SLM model id                    (default: $PHASE_SLM_MODEL or pi/$PI_MODEL or qwen2.5:0.5b)
--tools a,b,c     allowed tools                   (default: read,edit,test,bash)
--budget.k=v      budget override, e.g. --budget.wall_ms=120000
--adapter <id>    build a harness tool call (pi|codex|claude|gemini)
--stream          stream SLM tokens live (to stderr, stdout stays clean)
--stream-isa      stream the ISA plan inline as generated
--isa             print only the Phase ISA plan
--json            print the full JSON plan (default)
```

## Principles

- **Human intent dominates.** Constraints come from the caller; the allocator never invents project truth.
- **Smallest budget that likely finishes.** Model allocates conservatively, grows only on measured need.
- **Project facts stay in the project.** The model sees allocation state, never your codebase or secrets.
- **Bounded.** Every model decision is clamped to the caller's ceiling. The LLM can never overspend.
- **Zero dependencies.** Pure Node stdlib. Runs anywhere.

## Benchmarks & examples

- `examples/` — MCP tool definition, harness adapters, DAG tests, smoke test.
- `benchmark/` — real allocation research data (see `benchmark/report.md`).

```bash
npm run smoke        # CLI allocator + MCP server, offline, in one command
bash examples/smoke-test.sh
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Keep it small, bounded, dependency-free,
and always-working-offline.

## License

[MIT](LICENSE) · © FatCitten. Cite via [CITATION.cff](CITATION.cff).

---

<div align="center">Built to serve the agent — wherever your agent runs.</div>
