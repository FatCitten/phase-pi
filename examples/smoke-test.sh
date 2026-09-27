#!/usr/bin/env bash
# ISA-PRO smoke — offline, no agent needed. Exercises the kept core only.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "=== 1. unit tests ==="
if node --test "$ROOT/test/" >/dev/null 2>&1; then ok "node --test test/"; else no "node --test test/"; fi

HOME_TMP="$(mktemp -d)"

echo "=== 2. isa-alloc (heuristic, offline) ==="
OUT="$("$ROOT/bin/isa-alloc.mjs" "add rate limiting" --repo "$ROOT" --home "$HOME_TMP" 2>&1)"
echo "$OUT" | grep -q "ROUTE auto" && ok "ISA emits ROUTE" || no "ISA ROUTE"
echo "$OUT" | grep -q "GRANT read" && ok "ISA grants read" || no "ISA GRANT read"
echo "$OUT" | grep -q "ALLOC TOKENS" && ok "ISA allocs TOKENS" || no "ISA ALLOC TOKENS"

echo "=== 3. bus roundtrip ==="
BUS="$("$ROOT/bin/isa-bus.mjs" --home "$HOME_TMP" 2>&1)"
echo "$BUS" | grep -q "alloc.decision" && ok "bus carries alloc.decision" || no "bus alloc.decision"
"$ROOT/bin/isa-bus.mjs" emit ping repo=ready --home "$HOME_TMP" >/dev/null 2>&1
"$ROOT/bin/isa-bus.mjs" --home "$HOME_TMP" | grep -q "sig.ping" && ok "bus carries sig.ping" || no "bus sig.ping"

rm -rf "$HOME_TMP"

echo
echo "----- PASS=$PASS FAIL=$FAIL -----"
[ "$FAIL" -eq 0 ]
