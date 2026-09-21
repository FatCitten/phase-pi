#!/usr/bin/env bash
# phase — one-liner install. Pi-native.
#   curl -fsSL https://raw.githubusercontent.com/FatCitten/phase-pi/main/install.sh | bash
# Ensures Pi, installs phase into Pi, then opens Pi.
set -euo pipefail

echo "phase: Pi-native. Phase works only in Pi."

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

# 4. Install phase into Pi.
echo "phase: registering in Pi ->"
pi install "$PHASE_DIR" || echo "phase: pi install hiccup; continuing."

# 5. Open Pi.
echo "phase: ready in Pi. Try: phase_allocate \"add rate limiting\""
exec pi "$@"
