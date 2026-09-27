---
name: phase
description: "Use the phase coordination suite via native pi tools (phase_allocate, phase_orchestrate, phase_schedule, phase_bus_tickets, phase_chat, phase_reconcile, phase_taste) and/or the phase CLIs. Turn human intent into a bounded plan, drive concurrent agentic work through a control+data bus + atomic ticket system, verify completions against real signals, and retune the director's dials in-session. Each repo has one phase session (.phase/session.json) that survives pi restarts; /phase surfaces tickets, archive, taste, and resume to the human."
---

# Phase — coordination suite (v3: sessions · Jev geometry · verification · taste)

Phase coordinates human↔AI agentic work. This repo is **coordination only** — no
training. Project source and secrets never leave the repo.

Core rule: **"phase" means transition — LLMs propose, the deterministic runtime
disposes.** The model may propose tickets; every state mutation is an atomic
TicketStore op, never a model suggestion applied directly.

The decision hierarchy:

```
RULES (invariants) → JEV (exact geometry) → VERIFY (real signals) → LLM (generation only)
```

- **Jev** judges the round as zero-parameter geometry — never a model opinion.
- **Verification** interrogates completions against git evidence — an exit code
  is not proof.
- **The LLM** decomposes goals, does ticket work, and writes new objective text
  when geometry says replacement work is needed — nothing else.

## Tools (registered in this agent)

| Tool | Does |
|---|---|
| `phase_allocate` | Task → bounded plan: route, tool grants, budget, human-readable ISA |
| `phase_orchestrate` | Goal → tickets → concurrent workers → Jev review → RETRY/ADD/STOP |
| `phase_schedule` | Run tickets: parallel / `--pipeline` chain / `--dag` graph (+ `--drain` to resume) |
| `phase_bus_tickets` | Live status of a repo's ticket store |
| `phase_chat` | Conversational work spec: QUESTION loop → PERMISSION gate → deterministic scheduling |
| `phase_reconcile` | Evidence-based audit: mark tickets done only when a matching commit exists; dry-run by default |
| `phase_taste` | View/retune the director's dials; validates and writes atomically, effective next review |

All tools inherit the live model via `ctx.model` / `$PI_MODEL` (`src/provider.mjs`).
Default brain: **`glm-5.3-flash:cloud`** (light; no local model ever loads).
Set `PHASE_SLM_MODEL` / `PHASE_SLM_BASE_URL` to pin a different one.

## The /phase surface (what the human sees)

```
/phase                      interactive console: live ticket board (j/k select, r retry,
                            s steal stale, d drain, a archive, n new work, q close)
/phase chat                 work-specification dialogue (QUESTION / PERMISSION loop)
/phase tickets [panel|on|off]   ticket board / toggle the persistent live panel
/phase archive              compacted done tickets (digests)
/phase taste                the director's dials (view; set/reset via the tool)
```

Ticket events are human telemetry in three tiers — transcript entries, the
`/phase tickets` table, and the live panel — and are deliberately **not** sent
into LLM context (`pi.appendEntry`, not `sendMessage`).

At startup, a repo with open work prompts to resume (picker). `PHASE_NO_AUTODETECT=1`
suppresses it. Resume priority: live workers re-attach via leases → ISA/goal
restored from the manifest → open tickets re-claimable (`phase-schedule --drain`)
→ the linked pi chat is offered for reopening.

## The repo session — `.phase/session.json`

One session per repo (the workspace, not a chat). Created on the first ticket;
many pi chats and CLI workers attach to it over time.

```
.phase/
├── session.json    # id, name, goal, isa, pi_sessions[] (resume anchors)
├── workers.json    # live worker leases: pid + ticket + 15s heartbeat (dead pids reaped)
├── tickets/        # live: open / in_progress / failed
├── archive/        # compacted done tickets (digests); deps resolve against it too
└── bus/            # control.ndjson + data.ndjson (the event log)
```

## Roles & guardrails — scope, delegation, manager, HR

Agents work **only inside their assigned scope**; crossing scopes is prevented
by the deterministic runtime, not by politeness.

- **Scopes**: a ticket carries `meta.scope` (unscoped = general pool, any worker).
  A worker declares its grants (`--scope game,infra` or `$PHASE_SCOPES`).
- **Worker guardrail**: `TicketStore.claim` refuses out-of-scope tickets. A
  direct request records a `scope.violation` control event; pool scans filter
  silently (violations are logged only when the agent insisted).
- **Delegation is the only path across scopes**: `phase-role delegate T-XXXX
  --scope SCOPE` closes the ticket and opens a scoped child with the same
  objective — claimable only by workers granted that scope. No re-scoping in
  place, no self-delegation.
- **Manager** (`phase-role manager`): per-agent performance from the control
  bus → recommended token budgets, deterministic and clamped
  (`scale = 0.6 + 0.4*success; penalty = min(0.3, 0.1*violations)`,
  floor 8k / base 24k / ceiling 48k). The manager recommends; the allocator
  enforces ceilings. `--apply` emits `manager.review`.
- **HR** (`phase-role hr`): behavior audit — scope violations, flakiness,
  retry loops → flags (`scope-discipline`, `flaky`, `retry-loop`). **HR is
  read-only by construction**: it observes and flags; the human decides.
  `--apply` emits `hr.report`.

## Jev — bounded judgment as exact geometry

`src/jev.mjs` never asks a model for opinions. Ticket states are phases on the
unit circle (`passed→0`, `failed→π`); the round is the superposition `S = Σ v(φᵢ)`;
the cosine readout of `S` against the "done" anchor yields `goal_satisfied` as
the **exact passed-fraction**. All done → 1 (STOP); all failed → 0; half done →
0.5 (honestly ambiguous).

- Zero parameters: no training, no model, no network, no key. Review never
  touches an LLM; the generative model only writes new work when the geometry
  says unfixable failures exist.
- Precedence: retry fixable failures (bounded work first) → replace unfixable
  work → STOP when the geometry is clean. Unknown bands escalate, never guess.
- Observable: a `decision.jev` control event carries the geometry (alignment,
  unfixable, residual) and the policy applied.

## Verification — exit code is not evidence

`src/verify.mjs`, on by default (`verify.beforeStop: 'git-evidence'`). Before
the geometry reads the bits, every passing ticket must have a commit matching
its objective; otherwise its phase flips to failed and the geometry re-derives
truth: retry within the budget → unfixable → the LLM writes replacement work.
A lying worker can never ship; an honest worker that flaked once is retried and
its evidence-verified pass stops the loop. Non-git repos are trusted
automatically — never a stall. Orchestration exits 3 (not 0) with unproven work.

## Taste — the director's dials

The opinionated parts are a small file, editable **in-session** via
`phase_taste` (or `/phase taste` to view). Edits validate, write atomically,
and take effect on the next review — no restart.

```js
export const TASTE = {
  bands: { yes: 0.72, no: 0.28 },     // alignment → YES / NO / UNKNOWN
  retry: { maxAttempts: 2 },          // geometric retry budget per ticket
  followup: { maxPerRound: 3 },       // replacement work the LLM may write
  verify: { beforeStop: 'git-evidence' }, // or 'trust-exit-code'
  stop: { requireAllDone: true },     // false = "ship with known-broken residue"
};
```

Delete any line (or the file) to fall back to Phase defaults. You direct;
Phase manages.

## Long-running sprints

The native tools enforce a hard 300 s timeout — right for `phase_allocate`
(fast) and `phase_bus_tickets` (status). For sprint runs, launch the CLI
detached and poll; a killed scheduler leaves `pi -p` workers alive that keep
producing valid artifacts — `pgrep -af 'pi -p'`, then reconcile the store.

```bash
nohup node <phase>/bin/phase-schedule.mjs --dag graph.json --exec "npm test" \
  --repo . --count 3 > /tmp/sprint.log 2>&1 &
phase-bus tickets --repo .          # poll progress
```

`--dag` deps that are not ticket IDs fall back to objective-substring matching
(`"task 011"` matches an objective containing it) — use distinctive tokens.

## Principles

- **Human intent dominates.** The call is exactly what the user asked for; never invent scope.
- **Follow the plan.** Work within the granted tools and budget.
- **Project facts stay in the project.** Only allocation/coordination state reaches the model.
- **Bounded + fail-safe.** Every decision is clamped to the caller's ceiling; if the model
  endpoint is down, everything falls back to deterministic heuristics and still works offline.
- **Numbers have no model in the loop.** Judgment is geometry, completion is evidence;
  the LLM is in the loop only for generation.

## Reference

- Tools: `phase_allocate`, `phase_orchestrate`, `phase_schedule`, `phase_bus_tickets`, `phase_chat`, `phase_reconcile`, `phase_taste`.
- Commands: `/phase` (console), `/phase chat`, `/phase tickets [panel|on|off]`, `/phase archive`, `/phase taste`.
- Backend bins: `phase-alloc`, `phase-orchestrate`, `phase-schedule` (+ `--drain`), `phase-worker`, `phase-chat`, `phase-bus`, `phase-reconcile`, `phase-taste`.
- Brain auth: spawned CLIs inherit the live chat model and its API key via
  `ctx.modelRegistry.getProviderAuth` (fallback: pi's `~/.pi/agent/auth.json`).
  If phase tools 401 and silently degrade in a cloud setup, check this first.
  Reasoning models can return empty content if `max_tokens` is too small — phase
  requests 2048; raise it rather than switching models.
- Session design: `docs/sessions.md` (interview decisions, resume semantics, conflict layering).
- Jev architecture + bench: `docs/jev-architecture-comparison.md`, `bench/jev-compare.mjs`.
- Launcher: `./phase` bootstraps Pi. Full docs: `README.md`.
- Pi-only. No CLI-to-the-world, MCP, or adapters (later versions).