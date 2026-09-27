#!/usr/bin/env bash
#
# Wait for Vercel to finish deploying a commit, and say how it ended.
#
#   tests/diagnostics/wait_for_deploy.sh              the commit at HEAD
#   tests/diagnostics/wait_for_deploy.sh 99d65da      a specific commit
#   TIMEOUT=900 tests/diagnostics/wait_for_deploy.sh
#
# Polls the project's latest deployment every 10 s until the one for that
# commit is READY, ERROR or CANCELED (default limit 10 minutes). Exit status is
# 0 only for READY. Run it right after `git push` to the production branch.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/frontend"
SHA="${1:-$(git rev-parse --short=7 HEAD)}"
SHA="${SHA:0:7}"
TIMEOUT="${TIMEOUT:-600}"
read -r PROJECT TEAM < <(python3 -c \
  'import json;p=json.load(open(".vercel/project.json"));print(p["projectId"],p["orgId"])')

echo "waiting for the deployment of $SHA (up to ${TIMEOUT}s)"
deadline=$((SECONDS + TIMEOUT))
while ((SECONDS < deadline)); do
  line=$(vercel api "/v6/deployments?projectId=$PROJECT&teamId=$TEAM&limit=5" --raw 2>/dev/null |
    SHA="$SHA" python3 -c '
import json, os, sys
for d in json.load(sys.stdin)["deployments"]:
    if (d.get("meta") or {}).get("githubCommitSha", "").startswith(os.environ["SHA"]):
        print(d.get("state"), d.get("target"), d.get("url"))
        break
else:
    print("NOT_YET")
')
  echo "$(date +%T)  $line"
  case "$line" in
    READY*)            exit 0 ;;
    ERROR*|CANCELED*)  echo "build failed: vercel inspect --logs ${line##* }"; exit 1 ;;
  esac
  sleep 10
done
echo "timed out"; exit 1
