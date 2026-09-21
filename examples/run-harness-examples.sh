#!/usr/bin/env bash
# Per-harness examples: how each LLM agent calls phase as a servant tool.
# Phase decides allocation (route/tools/budget); the harness does the work.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Use the installed 'phase' bin if on PATH, else the local CLI.
if command -v phase >/dev/null 2>&1; then PHASE=phase; else PHASE="node $PROJECT_ROOT/bin/phase-alloc.mjs"; fi

# Pick a task
TASK="${1:-"add MCP tool definition for the phase allocator"}"
REPO="${2:-$PROJECT_ROOT}"

echo "=== Pi (print-mode): ISA plan as context ==="
$PHASE "$TASK" --repo "$REPO" --adapter pi --isa
echo

echo "=== Codex (exec worker): full JSON plan ==="
$PHASE "$TASK" --repo "$REPO" --adapter codex
echo

echo "=== Claude Code: full JSON plan ==="
$PHASE "$TASK" --repo "$REPO" --adapter claude | head -24
echo

echo "=== Gemini (headless): ISA plan ==="
$PHASE "$TASK" --repo "$REPO" --adapter gemini --isa
echo

echo "=== Heuristic (offline, always works) ==="
$PHASE "$TASK" --repo "$REPO" --policy heuristic --isa
