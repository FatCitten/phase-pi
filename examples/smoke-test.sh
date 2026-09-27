#!/usr/bin/env bash
# ISA-PRO smoke — offline, no agent needed. begin/exec/end roundtrip only.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "=== 1. unit tests ==="
if node --test "$ROOT/test/" >/dev/null 2>&1; then ok "node --test test/"; else no "node --test test/"; fi

HOME_TMP="$(mktemp -d)"

echo "=== 2. begin ==="
OUT="$("$ROOT/isa" begin "smoke task" --repo "$ROOT" --home "$HOME_TMP" 2>&1)"
echo "$OUT" | grep -q "RUN R-" && ok "run created" || no "run created"

echo "=== 3. exec inside the sandbox ==="
EXEC="$("$ROOT/isa" exec 'node -e "console.log(\"sandboxed-ok\")"' --repo "$ROOT" --home "$HOME_TMP" 2>&1)"
echo "$EXEC" | grep -q "sandboxed-ok" && ok "exec runs sandboxed" || no "exec sandboxed"

echo "=== 4. end (engine-measured) ==="
END="$("$ROOT/isa" end --passed --repo "$ROOT" --home "$HOME_TMP" 2>&1)"
echo "$END" | grep -q "DONE R-" && ok "end reports DONE" || no "end DONE"

echo "=== 5. bus record ==="
BUS="$("$ROOT/isa" bus --home "$HOME_TMP" 2>&1)"
echo "$BUS" | grep -q "run.begin" && ok "bus: run.begin" || no "bus run.begin"
echo "$BUS" | grep -q "run.done" && ok "bus: run.done" || no "bus run.done"

echo "=== 6. pointer cleared ==="
STATUS="$("$ROOT/isa" status --repo "$ROOT" --home "$HOME_TMP" 2>&1)"
echo "$STATUS" | grep -q "no active run" && ok "pointer cleared" || no "pointer cleared"

echo "=== 7. comprehension snapshot ==="
STATE="$("$ROOT/isa" state --repo "$ROOT" 2>&1)"
echo "$STATE" | grep -q "^repo isa-pro v" && ok "state: repo line" || no "state repo line"
echo "$STATE" | grep -q "^base " && ok "state: base diff" || no "state base diff"

rm -rf "$HOME_TMP"

echo
echo "----- PASS=$PASS FAIL=$FAIL -----"
[ "$FAIL" -eq 0 ]
