#!/usr/bin/env bash
#
# Push the local graph up to Supabase, using only the tools inside the
# Postgres container — nothing needs psql or pg_dump on the host.
#
#   ./scripts/push_to_supabase.sh
#   ./scripts/push_to_supabase.sh --container data-platform-postgres-1
#   ./scripts/push_to_supabase.sh --local-db codegraph --local-user postgres
#
# With no --local-db it finds the database in that container that actually
# holds the graph tables, and says what it found if there is any doubt.
#
# The target's five graph tables are REPLACED: `nodes` and `edges` key on a
# serial id rather than qualified name, so appending would duplicate the graph.
# The truncate and the reload run in ONE transaction, so a failure anywhere
# rolls back and the target keeps what it had.
#
set -euo pipefail

CONTAINER="data-platform-postgres-1"
LOCAL_USER="postgres"
LOCAL_DB=""
SB_HOST="aws-0-ap-southeast-2.pooler.supabase.com"
SB_PORT="5432"
SB_USER="postgres.rkeuovfdmmjebechozev"
SB_DB="postgres"
SB_SSLMODE="require"
ASSUME_YES=0
ALLOW_EMPTY=0

usage() { sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

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
    --allow-empty) ALLOW_EMPTY=1; shift ;;
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
LOCAL_USER="${LOCAL_USER:-$(env_value POSTGRES_USER)}"; LOCAL_USER="${LOCAL_USER:-postgres}"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
  echo "container '${CONTAINER}' is not running — docker compose up -d postgres" >&2
  exit 1
fi

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
SCHEMA_SQL="SET client_min_messages = warning;
$SCHEMA_SQL"

# --- find the source database before anything else -----------------------
FIND=$(cat <<'FIND_EOF'
if [ -n "${LOCAL_DB:-}" ]; then
  candidates="$LOCAL_DB"
else
  candidates=$(psql -U "$LOCAL_USER" -d postgres -qtAX \
    -c "SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn")
fi
found=""
for d in $candidates; do
  n=$(psql -U "$LOCAL_USER" -d "$d" -qtAX -c "
        SELECT count(*) FROM information_schema.tables
         WHERE table_schema='public'
           AND table_name IN ('repos','nodes','edges','files','imports');" 2>/dev/null) || continue
  [ "$n" = "5" ] && found="$found $d"
done
echo "ALL:$(echo $candidates | tr '\n' ' ')"
echo "GRAPH:$(echo $found)"
FIND_EOF
)
probe=$(docker exec -i -e LOCAL_USER="$LOCAL_USER" -e LOCAL_DB="$LOCAL_DB" \
  "$CONTAINER" sh -eu -c "$FIND")
all_dbs=$(sed -n 's/^ALL://p' <<<"$probe")
graph_dbs=$(sed -n 's/^GRAPH://p' <<<"$probe" | xargs || true)

if [[ -z "$graph_dbs" ]]; then
  echo "  No database in '${CONTAINER}' has the graph tables." >&2
  echo "  Databases there: ${all_dbs:-none}" >&2
  echo >&2
  echo "  This container may not be the code-graph one. Index a repo first, or" >&2
  echo "  point --container at the right Postgres." >&2
  exit 1
fi
if [[ $(wc -w <<<"$graph_dbs") -gt 1 ]]; then
  echo "  Several databases hold graph tables: $graph_dbs" >&2
  echo "  Pick one with --local-db." >&2
  exit 1
fi
LOCAL_DB="$graph_dbs"

# --- how much is actually there ------------------------------------------
src_nodes=$(docker exec -i -e LOCAL_USER="$LOCAL_USER" -e LOCAL_DB="$LOCAL_DB" "$CONTAINER" \
  sh -eu -c 'psql -U "$LOCAL_USER" -d "$LOCAL_DB" -qtAX -c "SELECT count(*) FROM nodes;"')

cat <<INFO

  from   ${CONTAINER} -> database '${LOCAL_DB}' as ${LOCAL_USER}  (${src_nodes} nodes)
  to     ${SB_USER}@${SB_HOST}:${SB_PORT}/${SB_DB} (sslmode=${SB_SSLMODE})

  REPLACES repos, nodes, edges, files and imports on the target, in one
  transaction — if anything fails, the target is left exactly as it was.

INFO

if [[ "$src_nodes" == "0" && "$ALLOW_EMPTY" -eq 0 ]]; then
  echo "  The source graph is empty. Refusing to wipe the target with nothing." >&2
  echo "  Index a repository first, or pass --allow-empty if that is the point." >&2
  exit 1
fi
if [[ "$SB_HOST" == db.*.supabase.co ]]; then
  echo "  ! That is the direct host, IPv6-only and unreachable from Docker." >&2
  echo >&2
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  read -r -p "  Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "  aborted"; exit 1; }
fi

read -r -s -p "  Supabase password for ${SB_USER}: " SB_PW
echo
[[ -n "$SB_PW" ]] || { echo "  no password given" >&2; exit 1; }

TARGET_URI="postgresql://${SB_USER}@${SB_HOST}:${SB_PORT}/${SB_DB}?sslmode=${SB_SSLMODE}"

# The password arrives on stdin and the schema after it: neither is ever in
# argv, where ps would show it.
INNER=$(cat <<'INNER_EOF'
IFS= read -r PGPASSWORD
export PGPASSWORD
SCHEMA=$(cat)

psql_t() { psql "$TARGET_URI" -qtAX -v ON_ERROR_STOP=1 "$@"; }
psql_l() { psql -U "$LOCAL_USER" -d "$LOCAL_DB" -qtAX -v ON_ERROR_STOP=1 "$@"; }

echo "  [1/4] checking the target is reachable, and its schema exists"
printf '%s\n' "$SCHEMA" | psql_t -f - >/dev/null

echo "  [2/4] dumping the local graph"
DUMP=$(mktemp)
trap 'rm -f "$DUMP"' EXIT INT TERM
# To a file, not a pipe: `sh` has no pipefail, so a failing pg_dump on the left
# of a pipe would look like success and we would load nothing over a truncated
# target.
if ! pg_dump -U "$LOCAL_USER" -d "$LOCAL_DB" \
       --data-only --no-owner --no-privileges \
       -t repos -t nodes -t edges -t files -t imports > "$DUMP"; then
  echo "  pg_dump failed — the target has not been touched." >&2
  exit 1
fi
[ -s "$DUMP" ] || { echo "  dump is empty — target untouched." >&2; exit 1; }

echo "  [3/4] replacing the target tables (single transaction)"
# TRUNCATE and the reload commit together or not at all.
{ echo 'TRUNCATE repos, nodes, edges, files, imports;'; cat "$DUMP"; } \
  | psql "$TARGET_URI" -q -v ON_ERROR_STOP=1 --single-transaction >/dev/null

# The dump carries explicit ids, so the target's serial sequences are still at
# 1 and the next insert there would collide.
psql_t -c "
  SELECT setval(pg_get_serial_sequence('nodes','id'),
                GREATEST(COALESCE((SELECT MAX(id) FROM nodes), 1), 1));
  SELECT setval(pg_get_serial_sequence('edges','id'),
                GREATEST(COALESCE((SELECT MAX(id) FROM edges), 1), 1));
" >/dev/null

echo "  [4/4] verifying row counts"
rc=0
for t in repos nodes edges files imports; do
  src=$(psql_l -c "SELECT count(*) FROM $t;")
  dst=$(psql_t -c "SELECT count(*) FROM $t;")
  if [ "$src" = "$dst" ]; then
    printf '        %-9s %s\n' "$t" "$src"
  else
    printf '        %-9s MISMATCH local=%s remote=%s\n' "$t" "$src" "$dst" >&2
    rc=1
  fi
done
exit $rc
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
