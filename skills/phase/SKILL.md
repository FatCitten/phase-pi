---
name: phase
description: "Use the phase coordination suite via three native pi tools (phase_allocate, phase_orchestrate, phase_schedule, phase_bus_tickets) and/or the phase CLIs. Turn human intent into a bounded plan and drive concurrent agentic work through a control+data bus + atomic ticket system, using pi's own LLM provider instead of a local SLM."
---

# Phase — coordination suite (v2 process runtime)

Phase coordinates human↔AI agentic work. A language model (small or large) is the
*brain*: it allocates, plans, chats, and drives concurrent workers. This repo is
**coordination only** — no training. Project source and secrets never leave the repo.

## The two ways to use it here

### 1. Single allocation (the `phase_allocate` tool)
Call `phase_allocate` before starting work to get a bounded plan:
`allocation.agent` (route), `allocation.tools` (grants), `allocation.budget`
(context/wall/tool-call ceilings), plus a human-readable `isa`.

```json
{ "task": "fix the failing auth tests", "repo": "/path/to/repo" }
{ "task": "...", "policy": "heuristic" }      // offline; always works
{ "task": "...", "policy": "model", "model": "qwen2.5:0.5b" }
```

### 2. Multi-ticket coordination (the runtime CLIs)
For multi-part work, drive tickets through the process runtime:

```bash
# Decompose goal -> schedule -> review -> RETRY/ADD/STOP (LLM/SLM brain, offline fallback)
phase-orchestrate "goal" --repo . --rounds 3 --count 4

# Independent, dependent, or graph tickets
phase-schedule "t1" "t2" --repo . --count 4             # parallel
phase-schedule --pipeline "a" "b" "c" --repo .          # linear chain (DAG deps)
phase-schedule --dag graph.json --exec "npm test"

# Run one worker by hand; observe the buses + tickets
phase-worker --repo . --exec "npm test"
phase-bus bus --follow --repo .      # stream control events
phase-bus tickets --repo .            # list tickets + status
```

### 3. Native pi tools (registered in this agent)
These are exposed as first-class tool calls inside pi (no shelling out):

- **`phase_allocate`** — single task → bounded plan (phase_allocate).
- **`phase_orchestrate`** — the LLM brain decomposes a goal → schedules tickets →
  reviews outcomes → RETRY/ADD/STOP across concurrent workers.
- **`phase_schedule`** — lay out tickets and run them (independent / `--pipeline` / `--dag`).
- **`phase_bus_tickets`** — live status of a repo's ticket store.

These native tools run against **the same LLM that's driving the current pi chat** — they inherit
the live model and provider from the session (`ctx.model` / `$PI_MODEL`) via `src/provider.mjs`,
so the allocator/orchestrator brain is whatever model you're already talking to (e.g.
`deepseek-v4-flash:0731-cloud` on local Ollama `http://127.0.0.1:11434/v1`).

- Set `PHASE_SLM_MODEL` / `PHASE_SLM_BASE_URL` (or `PHASE_LLM_MODEL` / `PHASE_LLM_BASE_URL`) to pin a
different brain model; otherwise phase falls back to the chat's model, then to a local
`qwen2.5:1.5b`. If you switch the chat model with `/model`, phase follows automatically.

> **Note on reasoning models (deepseek-v4-flash, kimi, qwen3):** they stream a long
> `reasoning` preamble and only emit the final answer in `content` once they've reasoned enough.
> With a too-small `max_tokens` the model burns its whole budget on reasoning and `content` comes
> back **empty** — that's the old "empty content on direct v1 calls" symptom. Phase now requests a
> generous `max_tokens` (2048) for the allocator/orchestrator so the answer always lands in
> `content`. If you ever see empty output, raise `max_tokens` rather than switching models.

## Principles
- **Human intent dominates.** The call is exactly what the user asked for; never invent scope.
- **Follow the plan.** Work within the granted tools and budget.
- **Project facts stay in the project.** Only allocation/coordination state reaches the model.
- **Bounded + fail-safe.** Every decision is clamped to the caller's ceiling; if the model
  endpoint is down, everything falls back to deterministic heuristics and still works offline.

## Reference
- Bins: `phase`, `phase-alloc`, `phase-orchestrate`, `phase-schedule`, `phase-worker`,
  `phase-bus`, `phase-chat`, `phase-chatroom`, `phase-mcp`.
- MCP server: `node src/mcp-server.mjs` (tool `phase_allocate`), per-call streaming.
- Harness adapters: `phase --adapter pi|codex|claude|gemini`.
- Full docs: `README.md` in the phase repo.
