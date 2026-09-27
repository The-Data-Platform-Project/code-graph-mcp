#!/usr/bin/env bash
#
# Check a deployed app end to end, without logging in, and show the server's
# own errors if anything fails.
#
#   tests/diagnostics/smoke_prod.sh                                   production
#   tests/diagnostics/smoke_prod.sh https://code-graph-xyz.vercel.app a preview
#
# What each check proves:
#   /api/health           200   the functions run at all
#   /                     307   the page gate redirects to /login
#   /login                200   the login page renders
#   /api/mcp, no token    401   the MCP route answers and rejects anonymous calls
#   /api/mcp, fake token  401   the database works: rejecting a token means
#                               looking it up in control.mcp_tokens, which needs
#                               DATABASE_URL, DATABASE_CA_CERT and the role's
#                               grants all to be right. A 500 here is a database
#                               problem; the logs printed below say which.
set -uo pipefail

B="${1:-https://code-graph-viz.vercel.app}"
B="${B%/}"
FE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../frontend" && pwd)"
fail=0

check() {  # label, expected code, curl args...
  local label="$1" want="$2"; shift 2
  local out code body
  out=$(curl -s -w $'\n%{http_code}' "$@")
  code="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [[ "$code" == "$want" ]]; then
    printf '  ok    %-24s %s\n' "$label" "$code"
  else
    printf '  FAIL  %-24s %s (want %s)  %s\n' "$label" "$code" "$want" "${body:0:160}"
    fail=1
  fi
}

echo "smoke-testing $B"
check "/api/health"          200 "$B/api/health"
check "/ -> /login"          307 "$B/"
check "/login"               200 "$B/login"
check "/api/mcp no token"    401 -X POST "$B/api/mcp" -H 'content-type: application/json' -d '{}'
check "/api/mcp fake token"  401 -X POST "$B/api/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer cgk_not_a_real_token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

if ((fail)); then
  echo
  echo "--- server errors, last 10 minutes"
  (cd "$FE" && timeout 60 vercel logs --since 10m --level error --expand 2>&1 |
     cut -c1-400 | sed -n '/^TIME/,$p' | tail -n 20)
  echo
  echo "  password authentication failed  -> DATABASE_URL password: tests/diagnostics/check_db_url.py"
  echo "  self-signed certificate         -> DATABASE_CA_CERT missing or wrong"
  echo "  permission denied               -> the codegraph_app GRANTs (ADMIN_GUIDE §2.2)"
  echo "  must be at least                -> OWNER_PASSWORD < 12 or SESSION_SECRET < 32 characters"
fi
exit "$fail"
