#!/usr/bin/env bash
# phase — one-liner install. Pi-native.
#   curl -fsSL https://raw.githubusercontent.com/FatCitten/phase-pi/main/install.sh | bash
# Ensures Pi, ensures phase installed in Pi, then opens Pi.
# Idempotent + non-destructive: never re-registers, never touches a live session,
# never spawns a nested Pi (that bricks it).
set -euo pipefail

echo "phase: Pi-native. Phase works only in Pi."

# 0. Never run nested — if already inside Pi, phase is present; just stop.
if [ -n "${PI_CODING_AGENT:-}" ] || [ -n "${PI_SESSION_FILE:-}" ]; then
  echo "phase: already inside Pi. Nothing to do — phase is live here."
  exit 0
fi

# 1. Clone (or reuse) phase-pi.
PHASE_DIR="${PHASE_ROOT:-$HOME/phase-pi}"
if [ ! -d "$PHASE_DIR/.git" ]; then
  echo "phase: fetching source ->"
  git clone --depth 1 https://github.com/FatCitten/phase-pi.git "$PHASE_DIR"
fi

# 2. Node / npm.
if ! command -v npm >/dev/null; then
  echo "phase: need Node >= 20. Get it first: https://nodejs.org"
  exit 1
fi

# 3. Pi.
if ! command -v pi >/dev/null; then
  echo "phase: Pi missing. Installing ->"
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  PREFIX="$(npm prefix -g 2>/dev/null || true)"
  [ -n "$PREFIX" ] && export PATH="$PREFIX/bin:$PATH"
fi
command -v pi >/dev/null || { echo "phase: Pi not on PATH. Add \$(npm prefix -g)/bin."; exit 1; }

# 4. Install phase into Pi — idempotently, via the safe launcher.
#    (The launcher backs up settings, matches existing registrations, and will
#     not spawn a nested Pi.) It also skips the handoff when inside Pi.
exec node "$PHASE_DIR/bin/phase.js" "$@"
