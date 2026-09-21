#!/usr/bin/env bash
# Smoke test for Phase: verify the CLI allocator and the MCP server both work.
# Uses only the granted tools read/edit/test/bash via heuristic (offline).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
ok(){ echo "✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "✗ $1"; FAIL=$((FAIL+1)); }

echo "=== 1. CLI allocator (heuristic, offline) ==="
OUT="$("$ROOT/bin/phase-alloc.mjs" "smoke test" --repo "$ROOT" --policy heuristic --isa)"
echo "$OUT" | grep -q '^ROUTE auto$' && ok "ISA emits ROUTE" || bad "missing ROUTE"
echo "$OUT" | grep -q 'GRANT read' && ok "ISA grants read" || bad "missing GRANT read"
echo "$ROOT/bin/phase-alloc.mjs" --adapters "" >/dev/null

echo "=== 2. MCP server (handshake + tools/list + tools/call) ==="
MCP_OUT="$("$ROOT/bin/phase-alloc.mjs" x --repo "$ROOT" --policy heuristic --isa >/dev/null; node "$ROOT/src/mcp-server.mjs" --ping 2>&1)"
echo "$MCP_OUT" | grep -q "handshake OK" && ok "MCP --ping handshake" || bad "MCP ping failed: $MCP_OUT"

# Full JSON-RPC session over stdio.
SESSION="$(node -e '
const { spawn } = require("child_process");
const s = spawn("node", ["src/mcp-server.mjs"], { cwd: process.cwd(), stdio:["pipe","pipe","ignore"] });
const send=o=>{const b=JSON.stringify(o);s.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`);};
let out="";s.stdout.on("data",c=>out+=c);
const w=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  send({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"t",version:"1"}}}); await w(150);
  send({jsonrpc:"2.0",id:2,method:"tools/list"}); await w(150);
  send({jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"phase_allocate",arguments:{task:"smoke",policy:"heuristic"}}}); await w(300);
  s.kill(); console.log(out);
})();
' 2>&1)" 
echo "$SESSION" | grep -q '"phase_allocate"' && ok "MCP tools/list exposes phase_allocate" || bad "tools/list missing tool"
echo "$SESSION" | grep -q 'allocation_policy.' && echo "$SESSION" | grep -q 'heuristic' && ok "MCP tools/call returns allocation" || bad "tools/call allocation missing"

echo
echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
