# Phase Sessions & Human-Visible Tickets — Design

Status: approved-in-principle (interview 2024, v1) · Target: phase v3
Principle preserved: **"phase" means transition — LLMs propose, the deterministic runtime disposes.** Every state transition stays in `src/` code (atomic ticket ops, drain loop, Jev). The LLM never mutates session/ticket state directly.

## 1. Decisions (from interview)

| # | Question | Decision |
|---|----------|----------|
| 1 | What is a session? | A **repo-based workspace**, pi-agent-agnostic. Survives pi session termination (the ABYSS case). |
| 2 | Sessions per repo | **One session per repo.** Multiple agents cooperate under one pi session. |
| 3 | How is it chosen? | **Picker + auto-detect** — "continue where you left off?" prompt at startup. |
| 4 | Ticket visibility | **Tiered:** (a) ticket events streamed into the chat transcript, (b) `/tickets` table command, (c) persistent TUI panel with live state. |
| 5 | Human role | **Interactive.** A special chat function to converse with the agent and specify work. |
| 6 | Ticket scope | **All tickets in the repo are visible**, regardless of who/what created them (CLI workers, prior sessions). |
| 7 | Resume priority | **D** (worker processes survive & re-attach) > **C** (plan/allocation/ISA) > **A** (open tickets re-claimable) > **B** (conversation context). |
| 8 | Done tickets | **Compacted and archived** — essential context retained (tool calls, edits), bulk dropped. |
| 9 | Conflict (stale writer) | **Jev + ISA.** Bounded yes/no judgment against the ISA; deterministic liveness checks come first, human escalation last. |
| 10 | Feature shape | **One phase surface** (`/phase`), not three scattered features. |
| 11 | State location | `.phase/` is coordination state — allowed. |

## 2. Data model

```
.phase/
├── session.json          # NEW — the one session per repo (the manifest)
├── workers.json          # NEW — live worker leases (pid, ticket, heartbeat)
├── tickets/              # existing — live tickets (open/in_progress/failed)
├── archive/              # NEW — compacted done tickets
│   └── T-0007.json       #   { ticket, digest, edits[], tool_calls[], summary }
├── bus/                  # existing — control.ndjson / data.ndjson
└── artifacts/            # existing
```

### `.phase/session.json` schema (v1)

```json
{
  "schema": "phase-session-v1",
  "id": "sess-<uuid>",
  "name": "abyss",                      // human label, defaults to repo dirname
  "repo": "/home/meowar/abyss",
  "created_at": "...", "updated_at": "...",
  "goal": "ship offline auth",          // last active goal
  "isa": { "route": "...", "tools": [...], "budget": {...} },  // last allocation
  "pi_sessions": [ "/home/meowar/.pi/agent/sessions/...jsonl" ], // linked pi sessions, newest first (for tier-B resume)
  "last_activity": "..."
}
```

The pi session ↔ phase session relationship is **many-to-one over time**: pi sessions come and go, the phase session persists in the repo. This is what makes it pi-agnostic.

### Worker leases (`.phase/workers.json`)

```json
{ "w-1": { "pid": 41233, "ticket_id": "T-0007", "agent": "worker-1",
           "started_at": "...", "heartbeat_at": "...", "host": "meowar" } }
```

Written atomically by `phase-worker` on start / claim / finish; heartbeat every ~15s during active work. This is the substrate for resume-D and the conflict rules.

## 3. The surface (one command, four verbs)

Registered by the phase extension; everything routes through it.

| Verb | What it does |
|------|-------------|
| `/phase` (bare) | **Surface home.** Auto-detect: if `.phase/` exists with open work → resume prompt (picker). If not → "start work in this repo?" |
| `/phase chat` | **Work-specification conversation.** The special chat function (§5). |
| `/phase tickets` | Ticket table (tier-b) or toggles the live panel (tier-c): `/phase tickets panel`. |
| `/phase archive` | Browse compacted done tickets (read-only digests). |

Startup flow (`session_start`, reason `startup`):
1. cwd has `.phase/session.json`? → notify + widget on.
2. Open/in-progress tickets exist? → auto-detect prompt: *"Continue ABYSS where you left off? (3 open, 1 in progress, last active 2h ago)"* → `ctx.ui.select` → resume (§6) or start fresh.
3. No `.phase/` → silent until the human asks. **No nagging on unrelated repos.**

## 4. Tiered ticket visibility

**Tier (a) — transcript events.** The extension tails `bus/control.ndjson` (fs.watch + offset read; also replays the tail on resume). Each lifecycle event renders via `pi.appendEntry("phase-event", ...)` + `pi.registerEntryRenderer()`:

```
▸ T-0007 claimed by worker-2        (deps: T-0005 ✓)
▸ T-0005 done — 2 edits, 1 test     (4m 12s)
▸ T-0007 failed — exit 1            ↻ retrying (round 2)
```

Deliberately **not** `pi.sendMessage` — ticket events are human telemetry and must not enter LLM context or pollute compaction. The agent reads state through tools when it needs it.

**Tier (b) — `/phase tickets`.** Table from `TicketStore.list()`: id, objective, status, worker, deps, age. Includes *all* repo tickets (decision 6) — CLI-created ones included — with origin marked.

**Tier (c) — persistent panel.** `ctx.ui.setWidget("phase", renderer)` below the editor: live counts, current claims, last event. Toggled via `/phase tickets panel` or a registered shortcut. RPC/print mode degrades to tier (a) entries only (`ctx.hasUI` guard).

## 5. The special chat function (interactive work specification)

Reuse `src/chat.mjs` (`ChatSession`) — it already implements exactly the loop: natural language + bounded instructions (TICKET/DEPENDS/CONSTRAINT/QUESTION/PERMISSION/RUN), ambiguity → QUESTION, each turn persisted on the data bus as a replayable artifact.

New native tool `phase_chat` + `/phase chat`:

1. Human describes work (in chat, via `pi.sendUserMessage` into the phase-chat loop or the tool's `onUpdate` stream).
2. Brain replies; if ambiguous → QUESTION is surfaced with `ctx.ui.input` and the answer fed back (bounded loop, max N clarifications, then human decides).
3. Confirmed intent → tickets proposed. With `PERMISSION` the human approves via `ctx.ui.confirm` before anything is created; with `RUN` (auto mode) tickets land and scheduling starts.
4. Every ticket creation/claim/finish flows onto the buses → tiers (a)/(c) light up automatically.

The LLM proposing tickets is fine (it's *proposing*); the TicketStore's atomic create/claim/finish remain the only way state actually changes.

## 6. Resume (priority D → C → A → B)

On resume (auto-detect or picker "continue"):

- **D — workers re-attach.** Read `workers.json`. For each lease with a live pid: re-attach by tailing buses; the panel shows "worker-1 → T-0007 (running, pid 41233)". **No pi involvement needed** — workers are detached processes; the session is just the observatory. Dead pids → conflict rules (§7).
- **C — plan/allocation/ISA.** `isa` + `goal` from `session.json` restored into the surface; new allocations inherit remaining budget where the ISA carries it.
- **A — open tickets.** Already works: `TicketStore.claim()` only hands out open tickets with deps done; fresh pi session + fresh workers pick the pipeline back up exactly where it stopped.
- **B — conversation context.** Last entry of `pi_sessions` is offered: *"also reopen the last pi chat for this work?"* → `ctx.switchSession()` (via command ctx), else a one-paragraph data-bus digest (`chat.assistant` tail + ticket outcomes) is injected as a session entry. Nothing is force-fed into context.

## 7. Done tickets — compact & archive

On `ticket.done` (and during `phase-reconcile`):

1. Build a digest: objective, result, artifact path, **edits list** (files touched, from worker report) and **tool-call summary** (counts + notable commands) — whatever the worker recorded in the data bus `ticket.output`.
2. Write `archive/T-XXXX.json` (the compact record) and remove `tickets/T-XXXX.ticket.json` + `.lock.done`.
3. Bulk transcript events are **never** kept verbatim; the digest is the durable record. `/phase archive` lists digests; the LLM can read an archive file on demand if it needs history.

This keeps `listTickets()`, the claim loop, and the panel small no matter how long a project runs.

## 8. Conflict resolution — rules → Jev → human

When resume (or any new claim) meets a possibly-stale writer:

**Layer 0 — deterministic (always runs).** Lease evidence is mechanical: pid alive? (kill(pid,0) / /proc), heartbeat age vs threshold, lock-file mtime, same host?
- Clearly dead (pid gone, lock stale) → steal deterministically: emit `sig.steal` on the control bus, reset ticket to `open`, log it. No LLM consulted.
- Clearly alive & fresh → do not touch; observe.

**Layer 1 — Jev with the ISA (ambiguous cases).** Alive pid but stale heartbeat, foreign host, worker claiming a ticket it hasn't touched in >N minutes. One bounded yes/no question — *"is worker w-1 dead, given its lease evidence and the ISA's expected cadence?"* — answered by `jevRoundJudgment` with the ISA and bus evidence as context, thresholds from `JEV_POLICY` (0.72/0.28). YES → steal. NO → wait/observe.

**Layer 2 — human.** UNKNOWN (Jev unavailable or in the 0.28–0.72 band) → never auto-act. Surface in the panel + picker: *"w-1 looks stuck on T-0007 — steal / leave / inspect?"*

Per the existing failure model: Jev absent → Layer 1 returns null → falls straight to Layer 2. No fake decisions.

## 9. Implementation plan

Ordered, each independently shippable:

1. **`session.json` manifest + leases** — `src/session.mjs`; workers write heartbeats; session auto-created on first ticket. (No UI yet.)
2. **Archive/compaction** — digest + move on done; `phase-reconcile` integration; `/phase archive`.
3. **Phase pi extension** — `/phase` command + verbs, startup auto-detect, tier (b) table, tier (a) transcript events via appendEntry, tier (c) widget. (This is where the phase extension currently lives is fine — extend, don't fork.)
4. **`phase_chat` native tool** — `src/chat.mjs` loop wired to `ctx.ui` for QUESTION/PERMISSION dialogs.
5. **Resume** — worker re-attach, ISA restore, pi-session handoff offer.
6. **Conflict layering** — Layer 0 in `TicketStore.claim` + lease checks; Layer 1 Jev hook; Layer 2 picker.

Tool surface after: existing 4 tools + `phase_chat`; new commands: `/phase`, `/phase chat|tickets|archive`.

## 10. Non-goals

- No multi-session-per-repo (one workspace per repo, by decision 2).
- No cross-repo sessions (a session is rooted in one repo; the picker only ever sees cwd's repo).
- No new storage outside `.phase/` — pi session files stay pi's, phase state stays phase's, linked only by path in `pi_sessions`.