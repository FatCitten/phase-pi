# Changelog

All notable changes to **phase-pi** are documented here, grouped by version.
The project follows [Semantic Versioning](https://semver.org).

## [2.0.0] — 2026-09-20

The Pi-release line. Rebuilt for the Pi agent as a first-class experience while
remaining a portable, dependency-free CLI and MCP server.

### Added
- **Bundled Pi package** (`pi-package`): `phase_allocate`, `phase_orchestrate`,
  `phase_schedule`, and `phase_bus_tickets` native tools plus the `phase` skill.
- **Portable root resolution**: the extension locates the runtime relative to its
  own file (works wherever `pi install` places it), with a `PHASE_ROOT` override.
- **Inherits the live chat model**: `phase_allocate` et al. use the same LLM &
  endpoint as the current Pi chat (`ctx.model` / `$PI_MODEL`), via `src/provider.mjs`.
- **Phase-ISA-driven orchestration** (`phase-orchestrate`): SLM/LLM decomposes →
  schedules → reviews → RETRY / ADD / STOP, with offline heuristic fallback.
- **Dependency-aware ticketing**: independent, `--pipeline` linear chains, and
  `--dag` graphs through the drain-loop scheduler.
- Streaming: `--stream` / `--stream-isa`, MCP per-call message notifications.
- Interactivity: `phase-chat` and `phase-chatroom` (`TICKET`/`DEPENDS`/`PERMISSION`/`RUN`).
- MCP server (stdio) exposing `phase_allocate`.

### Changed
- Package renamed/shipped as `phase-pi` (npm name available; the generic
  `phase` name was already taken on the public registry).

### Fixed
- Reasoning models (deepseek-v4-flash, kimi, qwen3) no longer yield empty
  `content`: allocator/orchestrator request `max_tokens: 2048`.
- Chatroom TUI clamps terminal rows so ANSI cursor position is never negative.

## [1.0.0] — 2026-09-15

Initial standalone release of the phase coordination runtime (CLI + MCP + buses +
heuristic/model allocation). Pre-pivot history retained prior to rebranding for Pi.
