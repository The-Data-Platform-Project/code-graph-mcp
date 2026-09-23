#!/usr/bin/env bash
#
# Push the local graph up to Supabase, using only the tools inside the
# Postgres container — nothing needs psql or pg_dump on the host.
#
#   ./scripts/push_to_supabase.sh
#   ./scripts/push_to_supabase.sh --container code-graph-postgres --local-db codegraph
#
# REPLACES the graph tables on Supabase. It truncates repos/nodes/edges/files/
# imports there and reloads them from the container, because `nodes` and
# `edges` are keyed on a serial id rather than on qualified name: appending a
# second copy would duplicate every node instead of updating it.
#
# The graph is derived data, so re-indexing against Supabase is usually simpler
# than this. Use this when you want the local index copied up as-is.
#
set -euo pipefail

CONTAINER="code-graph-postgres"
LOCAL_USER=""
LOCAL_DB=""
SB_HOST="aws-0-ap-southeast-2.pooler.supabase.com"
SB_PORT="5432"
SB_USER="postgres.rkeuovfdmmjebechozev"
SB_DB="postgres"
SB_SSLMODE="require"
ASSUME_YES=0

usage() { sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2 ;;
    --local-user) LOCAL_USER="$2"; shift 2 ;;
    --local-db) LOCAL_DB="$2"; shift 2 ;;
    --host) SB_HOST="$2"; shift 2 ;;
    --port) SB_PORT="$2"; shift 2 ;;
    --user) SB_USER="$2"; shift 2 ;;
    --db) SB_DB="$2"; shift 2 ;;
    --sslmode) SB_SSLMODE="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
DB_PY="$REPO_ROOT/src/code_graph/db.py"
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
command -v docker  >/dev/null || { echo "docker is required" >&2; exit 1; }

env_value() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1; }
LOCAL_USER="${LOCAL_USER:-$(env_value POSTGRES_USER)}"; LOCAL_USER="${LOCAL_USER:-codegraph}"
LOCAL_DB="${LOCAL_DB:-$(env_value POSTGRES_DB)}";       LOCAL_DB="${LOCAL_DB:-codegraph}"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
  echo "container '${CONTAINER}' is not running — docker compose up -d postgres" >&2
  exit 1
fi

# The schema, straight from the source of truth, so the target is guaranteed to
# match what the service expects before any data lands in it.
SCHEMA_SQL="$(python3 - "$DB_PY" <<'PY'
import ast, sys, pathlib
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
for node in tree.body:
    if isinstance(node, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id == "_SCHEMA" for t in node.targets
    ):
        print(ast.literal_eval(node.value)); break
else:
    sys.exit("could not find _SCHEMA in db.py")
PY
)"

# Re-runs would otherwise print a NOTICE per existing object.
SCHEMA_SQL="SET client_min_messages = warning;
$SCHEMA_SQL"

cat <<INFO

  from   container ${CONTAINER}, database ${LOCAL_DB} (as ${LOCAL_USER})
  to     ${SB_USER}@${SB_HOST}:${SB_PORT}/${SB_DB} (sslmode=${SB_SSLMODE})

  This REPLACES repos, nodes, edges, files and imports on the target.
  Anything already in those five tables there is deleted first.

INFO

if [[ "$SB_HOST" == db.*.supabase.co ]]; then
  echo "  ! That is the direct host, which is IPv6-only and unreachable from" >&2
  echo "    a default Docker network. Use the pooler host instead." >&2
  echo >&2
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  read -r -p "  Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "  aborted"; exit 1; }
fi

read -r -s -p "  Supabase password for ${SB_USER}: " SB_PW
echo
[[ -n "$SB_PW" ]] || { echo "  no password given" >&2; exit 1; }

# The password goes in on stdin, the schema after it: never in argv (ps would
# show it) and never in the host's environment. Inside the container it lives
# only in this one shell's PGPASSWORD.
TARGET_URI="postgresql://${SB_USER}@${SB_HOST}:${SB_PORT}/${SB_DB}?sslmode=${SB_SSLMODE}"

# The in-container script, built with a quoted heredoc so its SQL can use
# ordinary single quotes.
INNER=$(cat <<'INNER_EOF'
IFS= read -r PGPASSWORD
export PGPASSWORD
SCHEMA=$(cat)

psql_t() { psql "$TARGET_URI" -qtAX -v ON_ERROR_STOP=1 "$@"; }
psql_l() { psql -U "$LOCAL_USER" -d "$LOCAL_DB" -qtAX -v ON_ERROR_STOP=1 "$@"; }

echo "  [1/5] ensuring the schema exists on the target"
printf '%s\n' "$SCHEMA" | psql_t -f - >/dev/null

echo "  [2/5] clearing the target tables"
psql_t -c 'TRUNCATE repos, nodes, edges, files, imports;' >/dev/null

echo "  [3/5] copying rows"
pg_dump -U "$LOCAL_USER" -d "$LOCAL_DB" \
        --data-only --no-owner --no-privileges \
        -t repos -t nodes -t edges -t files -t imports \
  | psql_t >/dev/null

# The dump carries explicit ids, so the serial sequences on the target are
# still at 1 and the next insert there would collide. Fast-forward them.
echo "  [4/5] resetting id sequences"
psql_t -c "
  SELECT setval(pg_get_serial_sequence('nodes','id'),
                GREATEST(COALESCE((SELECT MAX(id) FROM nodes), 1), 1));
  SELECT setval(pg_get_serial_sequence('edges','id'),
                GREATEST(COALESCE((SELECT MAX(id) FROM edges), 1), 1));
" >/dev/null

echo "  [5/5] verifying row counts"
for t in repos nodes edges files imports; do
  src=$(psql_l -c "SELECT count(*) FROM $t;")
  dst=$(psql_t -c "SELECT count(*) FROM $t;")
  if [ "$src" = "$dst" ]; then
    printf '        %-9s %s\n' "$t" "$src"
  else
    printf '        %-9s MISMATCH local=%s remote=%s\n' "$t" "$src" "$dst" >&2
    exit 1
  fi
done
INNER_EOF
)

{ printf '%s\n' "$SB_PW"; printf '%s' "$SCHEMA_SQL"; } | docker exec -i \
  -e TARGET_URI="$TARGET_URI" \
  -e LOCAL_USER="$LOCAL_USER" \
  -e LOCAL_DB="$LOCAL_DB" \
  "$CONTAINER" sh -eu -c "$INNER"

cat <<'NEXT'

  Done. The target now holds the same graph as the container.

  On Vercel, point DATABASE_URL at the TRANSACTION pooler (port 6543, same
  user) and set GRAPH_SOURCE=postgres.

NEXT
