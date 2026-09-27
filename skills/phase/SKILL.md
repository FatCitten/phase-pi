---
name: phase
description: "Use the phase coordination suite via native pi tools (phase_allocate, phase_orchestrate, phase_schedule, phase_bus_tickets, phase_chat) and/or the phase CLIs. Turn human intent into a bounded plan and drive concurrent agentic work through a control+data bus + atomic ticket system, using pi's own LLM provider instead of a local SLM. Each repo has one phase session (.phase/session.json) that survives pi restarts; /phase surfaces tickets, archive, and resume to the human."
---

# Phase — coordination suite (v3: sessions + human-visible tickets)

Phase coordinates human↔AI agentic work. A language model (small or large) is the
*brain*: it allocates, plans, chats, and drives concurrent workers. This repo is
**coordination only** — no training. Project source and secrets never leave the repo.

Core rule: **"phase" means transition — LLMs propose, the deterministic runtime
disposes.** The model may propose tickets; every state mutation is an atomic
TicketStore op, never a model suggestion applied directly.

## Ways to use it here

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

> **Long-running sprints (agents that take minutes per ticket):** the native
> pi tools enforce a hard 300s timeout and will report "Command failed" even
> though the scheduler was working. For real sprint runs, launch the CLI
> detached and poll instead:
> ```bash
> nohup node /home/meowar/phase-pi/bin/phase-schedule.mjs \
>   --dag graph.json --exec "bash tools/firetable/phase-worker.sh" \
>   --repo . --count 3 > /tmp/sprint.log 2>&1 &
> phase-bus tickets --repo .   # poll progress
> ```
> The native tools remain right for `phase_allocate` (fast) and
> `phase_bus_tickets` (status). A killed scheduler leaves orphan `pi -p`
> workers running — `pgrep -af 'pi -p'` to find them; they keep producing
> valid artifacts, so reconcile the store afterwards instead of killing them.
>
> **DAG dependencies:** `depends_on` entries that are not ticket IDs fall
> back to objective-substring matching (e.g. `"011"` matches an objective
> containing `task 011`); use distinctive tokens (e.g. `"task 011"`) to
> avoid ambiguity.

### The repo session (v3) — `.phase/session.json`

Every repo has **one phase session**: the workspace, not a chat. It is
pi-agent-agnostic and survives pi termination. Created automatically on the
first ticket; many pi chats (and CLI workers) attach to it over time.

```
.phase/
├── session.json    # schema phase-session-v1: id, name, goal, isa, chat_id,
│                   # pi_sessions[] (last 10 pi chat files, newest-first)
├── workers.json    # live worker leases: pid + ticket + 15s heartbeat
├── tickets/        # live: open / in_progress / failed
├── archive/        # compacted done tickets (digest: result, artifact, worker)
└── bus/            # control.ndjson + data.ndjson (the event log)
```

- **Done tickets are archived** (compacted to a digest) — the live store stays
  small. Failed tickets stay live. `/phase archive` lists digests.
- **Worker leases** power resume: a lease whose pid is provably dead is reaped
  deterministically (`reapStale()`); foreign-host leases are never reaped
  (ambiguous → Jev/human, a later step).
- **`phase-schedule --drain`** runs no new tickets — it picks up whatever is
  open/in-progress (the resume path after a dead run). The native tools' hard
  300s timeout still applies; for long sprints prefer the detached CLI pattern
  above.

### 3. Native pi tools (registered in this agent)
These are exposed as first-class tool calls inside pi (no shelling out):

- **`phase_allocate`** — single task → bounded plan (phase_allocate).
- **`phase_orchestrate`** — the LLM brain decomposes a goal → schedules tickets →
  reviews outcomes → RETRY/ADD/STOP across concurrent workers.
- **`phase_schedule`** — lay out tickets and run them (independent / `--pipeline` / `--dag`).
- **`phase_bus_tickets`** — live status of a repo's ticket store.
- **`phase_chat`** — conversational work specification: pass the human's message
  to the phase brain; it replies with bounded instructions — a clarifying
  QUESTION (relay it to the human, then call again with the answer), proposed
  tickets behind a PERMISSION gate (the human confirms via dialog; on approval
  tickets are scheduled deterministically), or a direct plan.

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

## The /phase surface — what the human sees

The one command surface (registered by the phase extension). Tickets are
**human-visible in three tiers**; ticket events are telemetry for the human and
are deliberately NOT sent into LLM context (`pi.appendEntry`, not `sendMessage`):

| Tier | What | Where |
|------|------|-------|
| a | Ticket lifecycle events streamed into the transcript (`▸ T-0007 claimed by worker-2 … ✔ done`) | chat transcript (display-only entries) |
| b | `/phase tickets` — table of all live tickets (any origin, incl. CLI workers) | on demand |
| c | Persistent live panel: open/running/failed/archived + worker leases | widget above/below the editor, toggle `/phase tickets panel` |

Commands:

```
/phase                     the console: live ticket board + keyboard actions
/phase chat                interactive work-specification dialogue (QUESTION/PERMISSION loop)
/phase tickets [panel|on|off]   ticket board / toggle the live panel
/phase archive             compacted done tickets (digests)
```

The console (replaces typed commands for day-to-day steering): j/k select,
enter detail, **r** retry failed, **s** steal a stale in-progress ticket (only
when its lease is deterministically dead), **d** drain open tickets in the
background, **a** archive view, **n** new work (opens the chat dialogue),
**q** close. Auto-refreshes every 2s; runtime ops are TicketStore transitions
(`retryTicket`, `stealTicket`) — the console never mutates ticket files directly.

At pi startup, if the repo has a phase session with open work, phase binds the
chat to `.phase/session.json` and asks the human whether to resume (picker).
Set `PHASE_NO_AUTODETECT=1` to suppress the prompt. The session binding is by
repo — a new pi chat in the same cwd re-attaches to the same workspace.

**Resume priority** (when a pi session terminated mid-work): live workers
re-attach via leases (no pi involvement needed) → the last ISA/goal is restored
from the manifest → open tickets are re-claimable (`phase-schedule --drain`) →
the linked pi chat is offered for reopening from `pi_sessions`.

**Brain auth**: spawned phase CLIs inherit the live chat model AND its API key
(resolved via `ctx.modelRegistry.getProviderAuth`, falling back to pi's
`~/.pi/agent/auth.json`). Without this the brain 401s and silently degrades to
offline fallback — if phase tools seem dead in a cloud setup, check this first.
Conversations persist across `phase-chat` spawns via `--chat` (history replay
from the data bus, bounded to the last 20 turns).

## Jev — bounded judgment (zero-param geometry)

Round review does not ask a model for opinions. `src/jev.mjs` computes bounded
judgment as **exact geometry over the tickets themselves** (RULES → JEV → LLM):

ticket states are phases on the unit circle (`passed→0`, `failed→π`); the round is
the superposition `S = Σ v(φᵢ)`; the readout is the cosine projection of `S` onto
the "done" anchor. `goal_satisfied` comes out **exactly** the passed-fraction.
All done → 1 (STOP); all failed → 0; half done → 0.5 (honestly ambiguous).

- Zero parameters: no training, no model, no network, no API key. Review never
  touches an LLM; the generative model only WRITES new work when the geometry
  says unfixable failures exist (`followup`), and is the fallback when the
  geometry is escalated.
- Policy is precedence-based: retry fixable failures (bounded work first), then
  replace unfixable work, then STOP when the geometry is clean.
- Every decision is observable: a `decision.jev` event on the control bus carries
  the geometry (alignment, unfixable, residual) and the policy applied.
- **Director dials** live in `phase.taste.mjs` at the repo root — the opinionated,
  tasteful parts of the project:
  ```js
  export const TASTE = {
    bands: { yes: 0.72, no: 0.28 },   // alignment → YES / NO / UNKNOWN
    retry: { maxAttempts: 2 },        // geometric retry budget per ticket
    followup: { maxPerRound: 3 },     // replacement work the LLM may write
    verify: { beforeStop: 'git-evidence' },  // exit code is not evidence; STOP
                                              // requires a commit matching the
                                              // objective (real signals interrogated)
    stop: { requireAllDone: true },   // false = "ship with known-broken residue"
  };
  ```
- **Verification is on by default.** A passing exit code flips to failed when
  git history holds no evidence for the objective; the geometry then reads
  truth and re-runs (retry budget) or asks the LLM to replace the work. In a
  non-git repo the bits are trusted automatically — never a stall.
  Delete any line (or the file) to fall back to Phase defaults. Editing a line
  changes the decisions — you direct, Phase manages.
- Comparison against hosted Jev's published numbers and integration analysis:
  `docs/jev-architecture-comparison.md`; re-run the bench with
  `node bench/jev-compare.mjs` (our side works with no key).

## Principles
- **Human intent dominates.** The call is exactly what the user asked for; never invent scope.
- **Follow the plan.** Work within the granted tools and budget.
- **Project facts stay in the project.** Only allocation/coordination state reaches the model.
- **Bounded + fail-safe.** Every decision is clamped to the caller's ceiling; if the model
  endpoint is down, everything falls back to deterministic heuristics and still works offline.

## Reference
- Tools: `phase_allocate`, `phase_orchestrate`, `phase_schedule`, `phase_bus_tickets`, `phase_chat`.
- Commands: `/phase` (interactive console: live board + retry/steal/drain/archive/new-work), `/phase chat`, `/phase tickets [panel|on|off]`, `/phase archive`.
- Backend bins: `phase-alloc`, `phase-orchestrate`, `phase-schedule` (+ `--drain`), `phase-worker`, `phase-chat`, `phase-bus`.
- Session design: `docs/sessions.md` in the phase repo (interview decisions, resume semantics, conflict layering rules → Jev → human).
- Skill/launcher: `/phase`, or `./phase` to bootstrap Pi.
- Full docs: `README.md` in the phase repo.
- Pi-only. No CLI-to-the-world, MCP, or adapters (later versions).
