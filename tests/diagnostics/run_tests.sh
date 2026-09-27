#!/usr/bin/env bash
#
# Run the pytest suite against a Postgres container, and lint what you changed.
#
#   tests/diagnostics/run_tests.sh                     all tests, data-platform-postgres-1
#   tests/diagnostics/run_tests.sh -k sqlite_import    extra args go straight to pytest
#   CONTAINER=other-postgres tests/diagnostics/run_tests.sh
#
# The graph's Postgres publishes no host port, so this finds the container's IP
# on its Docker network and builds TEST_DATABASE_URL from the container's own
# superuser (the loader tests need CREATE DATABASE, which `codegraph` lacks).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="${CONTAINER:-data-platform-postgres-1}"
PY="${PY:-$HOME/cgvenv/bin}"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
  echo "container '$CONTAINER' is not running" >&2
  exit 1
fi

IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER")
U=$(docker exec "$CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo postgres)
P=$(docker exec "$CONTAINER" printenv POSTGRES_PASSWORD 2>/dev/null || true)
PE=$(P="$P" python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["P"],safe=""))')
export TEST_DATABASE_URL="postgresql://${U}:${PE}@${IP}:5432/postgres"
echo "testing against ${U}@${IP} ($CONTAINER)"

cd "$ROOT"
# Lint only the Python files changed against HEAD: the tree has older style
# findings that would drown out anything new.
mapfile -t changed < <(git diff --name-only --diff-filter=AM HEAD -- '*.py'; \
                       git ls-files --others --exclude-standard -- '*.py')
if ((${#changed[@]})); then
  echo "--- ruff (changed files)"
  "$PY/ruff" check "${changed[@]}" || true
fi

echo "--- pytest"
"$PY/pytest" "$@"
