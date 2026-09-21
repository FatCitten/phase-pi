#!/usr/bin/env bash
# phase — Pi-native smoke. Offline, no Pi needed.
# Exercises the internal backend the Pi extension shells out to.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "=== 1. Backend allocator (heuristic, offline) ==="
ISA="$("$ROOT/bin/phase-alloc.mjs" x --repo "$ROOT" --policy heuristic --isa 2>&1)"
echo "$ISA" | grep -q "ROUTE auto" && ok "ISA emits ROUTE" || no "ISA ROUTE"
echo "$ISA" | grep -q "GRANT read" && ok "ISA grants read" || no "ISA GRANT read"

echo "=== 2. Backend orchestrator (dry-run, offline) ==="
OUT="$("$ROOT/bin/phase-orchestrate.mjs" "ship offline auth" --repo "$ROOT" --dry-run 2>&1)"
echo "$OUT" | grep -q "ticket(s)" && ok "orchestrate decomposes goal" || no "orchestrate decompose"

echo "=== 3. Backend scheduler (dry-run) ==="
OUT2="$("$ROOT/bin/phase-schedule.mjs" "add a flag" "write docs" --repo "$ROOT" --count 1 --dry-run 2>&1)"
echo "$OUT2" | grep -q "tickets: 2" && ok "schedule lays out tickets" || no "schedule tickets"

echo
echo "----- PASS=$PASS FAIL=$FAIL -----"
[ "$FAIL" -eq 0 ]
