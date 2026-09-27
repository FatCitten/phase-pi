# Lessons ledger — what worked, what failed, what a restart must keep
*Phase-pi team, week of 2026-09-21 → 2026-09-27. Written at the PM's decision
point. Rule: every entry is first-person observed, with numbers. No
aspirational language. This document survives any team restart.*

## The ideas that are KEEP (verified by outcomes, not hope)

1. **Fresh-context ticket workers** (per-ticket git snapshot + nonce, nothing
   shared). Zero cross-ticket contamination observed across 15+ tickets.
2. **Atomic claim + lock file** — 15+ tickets across 2 repos, 0 double-claims.
3. **Deterministic verify as completion evidence** (`VERIFY PASS` gates).
   Caught the "exit-0 lie" case in tests; gates fail-closed in the wrapper.
4. **Zero-param geometry round review** (Jev): review with no model call,
   exact passed-fraction, honest 50/50. 17 tests. Cheapest correct reviewer
   we have; keep.
5. **Leases + heartbeat + Layer-0 steal**: turned tonight's silent scheduler
   death into a deterministically recoverable zombie claim instead of a
   hang. This worked *because* it was built before it was needed.
6. **Local gates first, engine validation as a separate explicit gate**
   (`game.sh check` vs `game.sh studio` fail-closed) — right architecture,
   catastrophically under-used (see FAIL #3).

## The failures — full detail, because these are the expensive part

### FAIL 1: One objective → one bounded ticket, no size gate (cost: 45 min → zero output)
Task 005b carried 4 deliverables + a 6-document reading list in one
single-shot bounded context. Worker read for 45 min, produced zero changes,
failed. Root cause: nothing between "objective" and "ticket" measured scope.
**Rule a restart must keep: one deliverable + one verify command per ticket;
decompose before scheduling, enforced in tooling, not by discipline.**
Decomposing task 015 into 3 tickets took ~4 minutes and each is 10× more
likely to complete than the mega-ticket.

### FAIL 2: Coordination runtime was itself O(n)-pathological (cost: ~91k junk events, 13MB bus, 13 min CPU)
Three compounding defects, all found only after they bled for days:
- drain-loop busy-wait respawned workers ~8×/s while idle (fixed: passive
  wait + one `pool.wait` event per episode, backoff 120ms→5s);
- `_nextSeq` read the ENTIRE bus file per event append (fixed: tail-read,
  ~100× on a 4MB bus);
- `_depsDone` re-read the whole archive per dep check (fixed: mtime-memoized
  index, 3.59→1.04ms).
**Lesson: every coordination-layer change ships with a before/after
measurement, or it doesn't ship.** All three were preventable with a
10-minute benchmark of the idle path.

### FAIL 3: Six days of "done" with the engine never running (cost: the entire sprint's ROI, deferred)
In-engine validation ran exactly once (Sep 21, gunfight-0 suite): 2/5 passed,
checks named `a`/`b` with placeholder details. Tasks 005, 005b, 011, 012,
013, 014 — all marked done on local-gate evidence only. The PM's metaphor:
"we thought it was ready for provisioning but the PSU wasn't even plugged in."
**Rule a restart must keep: a feature is not done until it runs where the
user runs it. Local gate = code compiles and logic is sound; engine gate =
product exists. Both, or neither counts.**

### FAIL 4: Session-start bound to cwd only (cost: every session started blind)
Launching pi from `~` (the human's actual launch path) silently bound no
phase session; the human had to manually redirect the agent from meta-work
back to the product. Fixed in 94d90f4 (portfolio autodetect: children +
siblings of launch dir, newest last_activity wins). **Lesson: test the
feature on the launch path the human actually uses, not the path the
developer had open.**

### FAIL 5: Silent process deaths with no telemetry (cost: ~19 min zombie claim, repeated confusion)
Scheduler pid 1546844 died mid-claim; nothing alerted; the zombie sat
`in_progress` until a human check. Also: phase-pi git history was rewritten
by an unaccounted writer (fixes survived — consolidated into 8f7b6c9 — but
the writer was never identified). **Rule: any long-lived process writes its
pid + heartbeat to the bus, and the extension surfaces a dead-scheduler
alert. Any unexplained repo mutation is a security item, not a curiosity.**

### FAIL 6: Budgets were decorative (cost: invisible, ongoing)
Worker "budget" said 24k tokens/5 min while the wrapper timeout was 45 min
and actual jobs needed ~15 min of reading before writing. The budget field
was never enforced and never derived from objective size. **Rule: either
enforce the budget or delete the field; a lie in the metadata is worse than
no metadata.**

## Routing doctrine (proposed to PM, evidence above)
- Default route: direct interactive work — fastest for exploratory, incident,
  and multi-step judgment tasks (the v2.2 sweep, the flap diagnosis).
- Ticket route: independent well-specified units (011–014 ran 4-wide
  successfully), unattended/overnight runs, evidence-critical verification.
- Hybrid: file a ticket for interactive work too — the ledger must show all
  outcomes, not just the ones that went through the queue.

## The discriminator that decides this system's fate
Finish 015a/b/c → stage a REAL in-engine check battery (damage regions,
recoil determinism, rewind reconcile, match flow, weapon assembler 17/16) →
human opens Studio 2 minutes → sprint runs in-engine or it doesn't.
Outcome = the team's verdict. This document records that the test was
available, cheap, and identified in advance.