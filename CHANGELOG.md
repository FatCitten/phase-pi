# Changelog

## 0.1.0 — 2026-09-27 — the strip

ISA-PRO is born out of phase-pi's failure. Everything deleted except the two
ideas that worked:

- **The ISA** — `ROUTE` / `GRANT` / `ALLOC`, emitted by a model or a
  deterministic heuristic, parsed, validated, clamped to caller ceilings.
- **The bus** — append-only control/data ndjson logs with O(1) tail seq.

Deleted: the ticket system (claims, locks, deps, retries, steals, delegation,
archive), the worker pool and its demo job, the orchestrator, the "Jev"
zero-param geometry reviewer, the hashed state-vector features, the
allocator seed/priors theater, the session manifest and leases, the roles
(manager/hr), the chat flows, git-evidence verification, the taste dials,
the benches and results, and the lessons ledger (it would poison future
context).

See `docs/isa.md` for the design the strip was done *for*.
