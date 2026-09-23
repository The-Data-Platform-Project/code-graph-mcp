#!/usr/bin/env bash
#
# Create the code-graph schema in Postgres — either the local Docker container
# or Supabase.
#
#   ./scripts/setup_db.sh --docker          the compose `postgres` service
#   ./scripts/setup_db.sh --supabase        the project's Supabase pooler
#   ./scripts/setup_db.sh --host HOST --port 5432 --user U --db D
#
# Safe to re-run: every statement is CREATE ... IF NOT EXISTS, so it never
# drops or rewrites anything already there.
#
# The schema is read out of src/code_graph/db.py rather than copied, so this
# script cannot drift from what the service actually expects.
#
set -euo pipefail

MODE="docker"                 # docker | network
CONTAINER="code-graph-postgres"
HOST="${PGHOST:-aws-0-ap-southeast-2.pooler.supabase.com}"
PORT="${PGPORT:-5432}"
USER="${PGUSER:-}"
DB="${PGDATABASE:-}"
SSLMODE="${PGSSLMODE:-require}"
ASSUME_YES=0

usage() { sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docker)
      MODE="docker"
      [[ "${2:-}" =~ ^[^-] ]] && { CONTAINER="$2"; shift; }
      shift ;;
    --supabase)
      MODE="network"
      USER="${USER:-postgres.rkeuovfdmmjebechozev}"
      DB="${DB:-postgres}"
      shift ;;
    --host) MODE="network"; HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --user) USER="$2"; shift 2 ;;
    --db)   DB="$2";   shift 2 ;;
    --sslmode) SSLMODE="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown option: $1" >&2; usage 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PY="$REPO_ROOT/src/code_graph/db.py"
ENV_FILE="$REPO_ROOT/.env"
[[ -f "$DB_PY" ]] || { echo "cannot find $DB_PY" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

# Read a KEY=value out of .env without sourcing it (values may contain
# anything, and sourcing would execute it).
env_value() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1
}

if [[ "$MODE" == "docker" ]]; then
  USER="${USER:-$(env_value POSTGRES_USER)}"; USER="${USER:-codegraph}"
  DB="${DB:-$(env_value POSTGRES_DB)}";       DB="${DB:-codegraph}"
else
  USER="${USER:-postgres}"
  DB="${DB:-postgres}"
fi

# --- the schema, straight from the source of truth ------------------------
SCHEMA_SQL="$(python3 - "$DB_PY" <<'PY'
import ast, sys, pathlib
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
for node in tree.body:
    if isinstance(node, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id == "_SCHEMA" for t in node.targets
    ):
        print(ast.literal_eval(node.value))
        break
else:
    sys.exit("could not find _SCHEMA in db.py")
PY
)"

# Re-runs would otherwise print a NOTICE per existing object, which reads like
# something went wrong when nothing did.
SCHEMA_SQL="SET client_min_messages = warning;
$SCHEMA_SQL"

tables=$(grep -c 'CREATE TABLE' <<<"$SCHEMA_SQL" || true)
indexes=$(grep -c 'CREATE INDEX' <<<"$SCHEMA_SQL" || true)

if [[ "$MODE" == "docker" ]]; then
  echo
  echo "  target    container ${CONTAINER} -> ${DB} as ${USER}"
else
  echo
  echo "  target    ${USER}@${HOST}:${PORT}/${DB}"
  echo "  sslmode   ${SSLMODE}"
fi
echo "  applying  ${tables} tables, ${indexes} indexes (idempotent)"
echo

if [[ "$MODE" == "network" && "$HOST" == db.*.supabase.co ]]; then
  cat >&2 <<'WARN'
  ! This is Supabase's DIRECT host, which resolves to IPv6 only. It will work
    from a machine with IPv6 but not from a default Docker network. The
    pooler host (aws-<n>-<region>.pooler.supabase.com) is the IPv4 one.

WARN
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  read -r -p "  Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "  aborted"; exit 1; }
fi

# --- docker: talk to the container over its own local socket --------------
if [[ "$MODE" == "docker" ]]; then
  command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }
  if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true; then
    echo "  container '${CONTAINER}' is not running." >&2
    echo "  start it with:  docker compose up -d postgres" >&2
    exit 1
  fi

  # Guard the identifier: it is interpolated into SQL below.
  case "$DB" in
    *[!A-Za-z0-9_]*|"") echo "  invalid database name: ${DB}" >&2; exit 1 ;;
  esac

  # The container may be one you already run for something else, with no
  # code-graph database in it yet.
  if ! docker exec -i "$CONTAINER" psql -U "$USER" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '${DB}'" | grep -qx 1; then
    echo "  database '${DB}' does not exist in ${CONTAINER} — creating it"
    docker exec -i "$CONTAINER" psql -U "$USER" -d postgres -q \
      -c "CREATE DATABASE ${DB}"
  fi

  # No password: the official postgres image trusts connections over the
  # container's own unix socket, which is what `docker exec psql` uses.
  echo "  applying schema..."
  docker exec -i "$CONTAINER" \
    psql --quiet --no-psqlrc --set ON_ERROR_STOP=1 -U "$USER" -d "$DB" \
    <<<"$SCHEMA_SQL"
  present="$(docker exec -i "$CONTAINER" \
    psql --quiet --no-psqlrc --tuples-only --no-align -U "$USER" -d "$DB" -c "
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() ORDER BY table_name;")"
  PW="$(env_value POSTGRES_PASSWORD)"
  URL_HOST="127.0.0.1"; URL_PORT="5432"; URL_SSL=""
else
  # --- network: password, never in argv, never echoed --------------------
  read -r -s -p "  Password for ${USER}: " PW
  echo
  [[ -n "$PW" ]] || { echo "  no password given" >&2; exit 1; }

  # A .pgpass file rather than PGPASSWORD: a process environment is readable,
  # and this keeps the secret in one 0600 file deleted on exit.
  PGPASSFILE="$(mktemp)"; chmod 600 "$PGPASSFILE"
  trap 'rm -f "$PGPASSFILE"' EXIT INT TERM
  escaped="${PW//\\/\\\\}"; escaped="${escaped//:/\\:}"
  printf '%s:%s:%s:%s:%s\n' "$HOST" "$PORT" "$DB" "$USER" "$escaped" > "$PGPASSFILE"
  export PGPASSFILE PGHOST="$HOST" PGPORT="$PORT" PGUSER="$USER" \
         PGDATABASE="$DB" PGSSLMODE="$SSLMODE" PGCONNECT_TIMEOUT=15

  command -v psql >/dev/null || {
    echo "  psql not found — install postgresql-client, or use --docker" >&2
    exit 1
  }
  echo "  connecting..."
  psql --quiet --no-psqlrc --set ON_ERROR_STOP=1 -f - <<<"$SCHEMA_SQL"
  present="$(psql --quiet --no-psqlrc --tuples-only --no-align -c "
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() ORDER BY table_name;")"
  URL_HOST="$HOST"; URL_PORT="$PORT"; URL_SSL="?sslmode=${SSLMODE}"
fi

# --- verify ---------------------------------------------------------------
missing=()
for t in repos nodes edges files imports; do
  grep -qx "$t" <<<"$present" || missing+=("$t")
done
echo
if ((${#missing[@]})); then
  echo "  FAILED: missing ${missing[*]}" >&2
  exit 1
fi
echo "  schema ready: repos, nodes, edges, files, imports"

# --- offer to record the connection string --------------------------------
if [[ -n "${PW:-}" ]]; then
  encoded="$(CG_PW="$PW" python3 -c \
    'import os,urllib.parse;print(urllib.parse.quote(os.environ["CG_PW"], safe=""))')"
  URL="postgresql://${USER}:${encoded}@${URL_HOST}:${URL_PORT}/${DB}${URL_SSL}"

  echo
  if [[ "$MODE" == "docker" ]]; then
    echo "  The compose services build their own DATABASE_URL from POSTGRES_*."
    echo "  This one is for host-side tools (check_db.py, pytest):"
  fi
  if [[ "$ASSUME_YES" -eq 0 ]]; then
    read -r -p "  Write DATABASE_URL into .env? [y/N] " reply
  else
    reply="n"
  fi

  if [[ "$reply" =~ ^[Yy]$ ]]; then
    touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
    if grep -q '^DATABASE_URL=' "$ENV_FILE"; then
      tmp="$(mktemp)"; chmod 600 "$tmp"
      grep -v '^DATABASE_URL=' "$ENV_FILE" > "$tmp"
      mv "$tmp" "$ENV_FILE"
    fi
    printf 'DATABASE_URL=%s\n' "$URL" >> "$ENV_FILE"
    echo "  wrote DATABASE_URL to .env (mode 600, gitignored)"
  else
    echo
    echo "    DATABASE_URL=postgresql://${USER}:<password>@${URL_HOST}:${URL_PORT}/${DB}${URL_SSL}"
  fi
fi

cat <<'NEXT'

  Next:
    python scripts/check_db.py          confirm the app can reach it
    docker compose up -d                start the stack
    then index a repository             the graph is derived data

NEXT
