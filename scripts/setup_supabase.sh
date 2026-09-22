#!/usr/bin/env bash
#
# Create the code-graph schema in Supabase (or any Postgres).
#
# Prompts for the password, applies the schema, and verifies the result. Safe
# to re-run: every statement is CREATE ... IF NOT EXISTS, so it never drops or
# rewrites anything that is already there.
#
# The schema is read out of src/code_graph/db.py rather than copied, so this
# script cannot drift from what the service actually expects.
#
#   ./scripts/setup_supabase.sh                    # the project's Supabase
#   ./scripts/setup_supabase.sh --host localhost --port 5432 --user postgres
#
set -euo pipefail

# --- defaults: the session pooler, which is IPv4. The direct host
# --- (db.<ref>.supabase.co) is IPv6-only and unreachable from Docker.
HOST="${PGHOST:-aws-0-ap-southeast-2.pooler.supabase.com}"
PORT="${PGPORT:-5432}"
USER="${PGUSER:-postgres.rkeuovfdmmjebechozev}"
DB="${PGDATABASE:-postgres}"
SSLMODE="${PGSSLMODE:-require}"
ASSUME_YES=0

usage() {
  sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
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
[[ -f "$DB_PY" ]] || { echo "cannot find $DB_PY" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

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

cat <<INFO

  target    ${USER}@${HOST}:${PORT}/${DB}
  sslmode   ${SSLMODE}
  applying  ${tables} tables, ${indexes} indexes (idempotent)

INFO

if [[ "$HOST" == db.*.supabase.co ]]; then
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

# --- password: never in argv, never echoed, never in shell history --------
read -r -s -p "  Password for ${USER}: " PGPW
echo
[[ -n "$PGPW" ]] || { echo "  no password given" >&2; exit 1; }

# A .pgpass file rather than PGPASSWORD: the environment of a running process
# is readable, and this keeps the secret in one 0600 file we delete on exit.
PGPASSFILE="$(mktemp)"
chmod 600 "$PGPASSFILE"
cleanup() { rm -f "$PGPASSFILE"; }
trap cleanup EXIT INT TERM

# In .pgpass, backslash and colon are escaped.
escaped="${PGPW//\\/\\\\}"
escaped="${escaped//:/\\:}"
printf '%s:%s:%s:%s:%s\n' "$HOST" "$PORT" "$DB" "$USER" "$escaped" > "$PGPASSFILE"
export PGPASSFILE PGHOST="$HOST" PGPORT="$PORT" PGUSER="$USER" \
       PGDATABASE="$DB" PGSSLMODE="$SSLMODE" PGCONNECT_TIMEOUT=15

# --- apply ----------------------------------------------------------------
apply_with_psql() {
  psql --quiet --no-psqlrc --set ON_ERROR_STOP=1 -f - <<<"$SCHEMA_SQL"
  psql --quiet --no-psqlrc --tuples-only --no-align -c "
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() ORDER BY table_name;"
}

apply_with_python() {
  CG_SCHEMA="$SCHEMA_SQL" CG_PW="$PGPW" python3 - <<'PY'
import os, sys
try:
    import psycopg
except ImportError:
    sys.exit("neither psql nor psycopg is available; install one of them")
con = psycopg.connect(
    host=os.environ["PGHOST"], port=os.environ["PGPORT"],
    user=os.environ["PGUSER"], dbname=os.environ["PGDATABASE"],
    password=os.environ["CG_PW"], sslmode=os.environ["PGSSLMODE"],
    connect_timeout=15,
)
with con:
    con.execute(os.environ["CG_SCHEMA"])
    rows = con.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = current_schema() ORDER BY table_name"
    ).fetchall()
print("\n".join(r[0] for r in rows))
con.close()
PY
}

echo "  connecting..."
if command -v psql >/dev/null; then
  present="$(apply_with_psql)"
else
  echo "  (psql not found — using psycopg)"
  present="$(apply_with_python)"
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
ENV_FILE="$REPO_ROOT/.env"
encoded="$(CG_PW="$PGPW" python3 -c \
  'import os,urllib.parse;print(urllib.parse.quote(os.environ["CG_PW"], safe=""))')"
URL="postgresql://${USER}:${encoded}@${HOST}:${PORT}/${DB}?sslmode=${SSLMODE}"

echo
if [[ "$ASSUME_YES" -eq 0 ]]; then
  read -r -p "  Write DATABASE_URL into .env? [y/N] " reply
else
  reply="n"
fi

if [[ "$reply" =~ ^[Yy]$ ]]; then
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  # Replace an existing DATABASE_URL rather than appending a second one.
  if grep -q '^DATABASE_URL=' "$ENV_FILE"; then
    tmp="$(mktemp)"; chmod 600 "$tmp"
    grep -v '^DATABASE_URL=' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  fi
  printf 'DATABASE_URL=%s\n' "$URL" >> "$ENV_FILE"
  echo "  wrote DATABASE_URL to .env (mode 600, gitignored)"
else
  echo "  Add this to .env yourself (the password is percent-encoded):"
  echo
  echo "    DATABASE_URL=postgresql://${USER}:<password>@${HOST}:${PORT}/${DB}?sslmode=${SSLMODE}"
fi

cat <<'NEXT'

  Next:
    python scripts/check_db.py          confirm the app can reach it
    docker compose up -d                start the stack against Supabase
    then re-index each repository       the graph is derived data

  For Vercel use the TRANSACTION pooler instead: same host and user, port 6543.

NEXT
