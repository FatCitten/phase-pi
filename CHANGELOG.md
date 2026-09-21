# Changelog

All notable changes, grouped by version. [SemVer](https://semver.org).

## [2.1.0] — v1 Pi-native pivot

Phase becomes **Pi-only**. One entrypoint: run it → ensure Pi, install phase into
Pi, open Pi.

### Added
- `phase` launcher (`bin/phase.js`) + `phase` repo script + `install.sh` one-liner.
- All bootstrap Pi: installs Pi if missing, `pi install` phase, hands off.

### Removed
- MCP server, harness adapters, "works anywhere" CLI story. Pi-only now.
  Adapters come in later versions.

## [2.0.0] — 2026-09-20

Bundled Pi package + skill + engine.

### Added
- `phase_allocate`, `phase_orchestrate`, `phase_schedule`, `phase_bus_tickets`
  native tools + `phase` skill.
- Engine: alloc → orchestrate → review → RETRY/ADD/STOP; tickets (parallel /
  pipeline / DAG); offline heuristic fallback; `phase-chat`/`phase-chatroom`.
- Inherits Pi's live model via `src/provider.mjs` (`ctx.model` / `$PI_MODEL`).

### Fixed
- Reasoning models no longer empty: `max_tokens: 2048`.
- Chatroom TUI clamps rows; cursor never negative.

## [1.0.0] — 2026-09-15

Initial phase runtime (allocator + buses + heuristic/model allocation).
