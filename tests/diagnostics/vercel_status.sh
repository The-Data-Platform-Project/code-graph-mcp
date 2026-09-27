#!/usr/bin/env bash
#
# Show how the Vercel project is set up: login, link, build settings,
# production branch, environment variables, and the latest deployment.
#
#   tests/diagnostics/vercel_status.sh
#
# Read-only. Values of sensitive variables are never shown (Vercel won't
# return them); plain ones appear encrypted in `vercel env ls`, which is normal.
set -uo pipefail

FE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../frontend" && pwd)"
cd "$FE"

echo "--- login"
vercel whoami 2>&1 | tail -n 1

if [[ ! -f .vercel/project.json ]]; then
  echo "frontend/ is not linked: vercel link --project code-graph-viz" >&2
  exit 1
fi
read -r PROJECT TEAM < <(python3 -c \
  'import json;p=json.load(open(".vercel/project.json"));print(p["projectId"],p["orgId"])')
echo "--- linked to $PROJECT (team $TEAM)"

echo "--- project settings"
vercel api "/v9/projects/$PROJECT?teamId=$TEAM" --raw 2>/dev/null | python3 -c '
import json, sys
p = json.load(sys.stdin)
link = p.get("link") or {}
want = {"rootDirectory": "frontend", "framework": "nextjs"}
for k in ("name", "rootDirectory", "framework", "buildCommand", "installCommand", "nodeVersion"):
    v = p.get(k)
    bad = k in want and v != want[k]
    print(f"  {k:<16} {v}" + (f"   <- should be {want[k]}" if bad else ""))
print("  git              " + str(link.get("org")) + "/" + str(link.get("repo")))
print("  production from  " + str(link.get("productionBranch")))
'

echo "--- environment variables"
vercel env ls 2>&1 | sed -n '/^ name/,$p'
echo "  the app needs, in production: DATABASE_URL DATABASE_CA_CERT PGPOOL_MAX OWNER_PASSWORD"
echo "  SESSION_SECRET SOURCE_PROVIDER GITHUB_TOKEN MCP_BACKEND"

echo "--- latest deployment"
vercel api "/v6/deployments?projectId=$PROJECT&teamId=$TEAM&limit=1" --raw 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)["deployments"][0]
m = d.get("meta") or {}
print(" ", d.get("state"), d.get("target"), m.get("githubCommitRef"), m.get("githubCommitSha", "")[:7], d.get("url"))
'
