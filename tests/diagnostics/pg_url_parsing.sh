#!/usr/bin/env bash
#
# Show how the app's database driver reads a connection string: which user,
# password and host node-postgres will actually use.
#
#   tests/diagnostics/pg_url_parsing.sh
#   tests/diagnostics/pg_url_parsing.sh 'postgresql://u.ref:p@ss#w0rd@host:6543/postgres'
#
# Use a made-up password with the same special characters as the real one;
# the string is printed. It installs the pg and pg-connection-string versions
# pinned in frontend/package-lock.json into a throwaway folder (not the app's
# node_modules), then parses the URL twice: as given, and after `new URL()`,
# which is what frontend/lib/pool.ts does when DATABASE_CA_CERT is set.
#
# Finding recorded 2026-09-28 (pg 8.23.0): an unencoded "@" in the password is
# parsed correctly both ways. Other characters (# ? / % :) are not safe unencoded.
set -euo pipefail

URL="${1:-postgresql://codegraph_app.ref:abc@def12345@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres}"
FE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../frontend" && pwd)"
lock() {
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['packages']['node_modules/$1']['version'])" \
    "$FE/package-lock.json"
}
PGV=$(lock pg); PCSV=$(lock pg-connection-string)
echo "pinned: pg $PGV, pg-connection-string $PCSV"

D="${TMPDIR:-/tmp}/cg-pg-url-parsing"
mkdir -p "$D"; cd "$D"
[[ -f package.json ]] || npm init -y >/dev/null
npm install --silent "pg@$PGV" "pg-connection-string@$PCSV" >/dev/null 2>&1

URL="$URL" node -e '
const { parse } = require("pg-connection-string");
const raw = process.env.URL;
let viaUrl;
try { viaUrl = new URL(raw).toString(); } catch (e) { viaUrl = null; console.log("new URL() threw:", e.message); }
for (const [label, s] of [["as given", raw], ["after new URL()", viaUrl]]) {
  if (!s) continue;
  const c = parse(s);
  console.log(`${label.padEnd(16)} user=${c.user}  password=${c.password}  host=${c.host}  port=${c.port}  db=${c.database}`);
}
'
