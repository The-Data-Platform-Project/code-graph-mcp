#!/usr/bin/env python3
"""Test a DATABASE_URL before you give it to Vercel. Never prints the password.

    ~/cgvenv/bin/python tests/diagnostics/check_db_url.py
    ~/cgvenv/bin/python tests/diagnostics/check_db_url.py --schema tenant_owner

Asks for the URL at a hidden prompt, shows how it parses (user, host, port,
database, password *length*, and any characters that ought to be
percent-encoded), then logs in on its own port and, for a transaction-pooler
URL (6543), on the session pooler (5432) too. Once logged in, it counts the
tenant's nodes, which proves the role's grants as well as its password.

Reading the result:
  OK on both ports             the URL is right; if the app still fails, the
                               value stored in Vercel differs: use
                               set_vercel_db_url.py to store this exact one
  password authentication      the role does not have that password (or it
  failed                       was changed in a different Supabase project)
  permission denied for        login works, but the ADMIN_GUIDE §2.2 GRANTs
  schema/table                 are missing
  Tenant or user not found     the user lacks the .<project-ref> suffix, or
                               the host is another region's pooler
"""

from __future__ import annotations

import argparse
import getpass
from urllib.parse import unquote, urlsplit

import psycopg


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--schema", default="tenant_owner", help="tenant schema to count nodes in")
    args = ap.parse_args()

    url = getpass.getpass("  DATABASE_URL (hidden): ").strip()
    u = urlsplit(url)
    raw_pw = u.password or ""
    pw = unquote(raw_pw)
    print(f"  scheme   {u.scheme}")
    print(f"  user     {unquote(u.username or '')}")
    print(f"  host     {u.hostname}")
    print(f"  port     {u.port}")
    print(f"  db       {u.path.lstrip('/')}")
    odd = sorted({c for c in raw_pw if not (c.isalnum() or c in "-._~%")})
    print(f"  password {len(pw)} chars" + (
        f", unencoded special characters: {' '.join(odd)}" if odd
        else ", no characters needing encoding"))
    if any(c in pw for c in "<> "):
        print("  ! the password contains < > or a space: is a placeholder still in it?")

    ok = True
    for port in dict.fromkeys(p for p in (u.port or 5432, 5432 if u.port == 6543 else None) if p):
        try:
            with psycopg.connect(
                host=u.hostname, port=port, user=unquote(u.username or ""), password=pw,
                dbname=u.path.lstrip("/") or "postgres", sslmode="require", connect_timeout=15,
            ) as con:
                who = con.execute("SELECT current_user").fetchone()[0]
                n = con.execute(f'SELECT COUNT(*) FROM "{args.schema}".nodes').fetchone()[0]
                print(f"  port {port}: OK, logged in as {who}; {args.schema}.nodes = {n}")
        except psycopg.Error as exc:
            ok = False
            print(f"  port {port}: FAILED: {str(exc).strip().splitlines()[-1]}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
