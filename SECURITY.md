# Security

ISA-PRO's only responsibility is to confine work to a run's sandbox and keep
an honest record. The trust boundary is narrow and explicit.

## Principles

- **The sandbox is the boundary.** While a run is active, writes outside the
  run's sandbox and the ledger (`.isa/`) are denied by the harness hook.
  `isa exec` runs inside a bwrap jail when available: read-only root, write
  only to the sandbox, fresh `/tmp`. Without bwrap it degrades to plain
  confinement (cwd jailed, env stripped) — never silently unconfined.
- **Measured, never self-reported.** Wall-time and exec count come from the
  engine's clock; tool calls and tokens from the harness hooks. The record
  contains only measured facts; nothing trusts a claim.
- **The bus is append-only.** The ledger and the bus are writable by design —
  they are the record. Replay is truth; nothing else is trusted state.
- **The plugin runs with your session's permissions** (like any OpenCode
  plugin). It shells out to the `isa` CLIs via a real Node runtime only.
  Never point `ISA_ROOT`, `ISA_HOME`, or `NODE` at untrusted content.

## Confinement honesty

bwrap is used when present, plain confinement otherwise. The run record says
which kind applied on every `run.exec` event — a reader can always tell
whether the jail was real.

## Reporting

Please report security issues privately to the repository maintainers rather
than in a public issue. Do not share exploit details publicly before a fix is
available.
