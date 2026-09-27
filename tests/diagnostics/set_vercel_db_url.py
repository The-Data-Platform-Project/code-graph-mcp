#!/usr/bin/env python3
"""Verify a DATABASE_URL logs in, then store exactly that URL in Vercel.

    ~/cgvenv/bin/python tests/diagnostics/set_vercel_db_url.py
    ~/cgvenv/bin/python tests/diagnostics/set_vercel_db_url.py --target preview

The URL is read once at a hidden prompt, tested (login plus a count of the
tenant's nodes), and only if that works is it piped to
`vercel env add DATABASE_URL <target> --sensitive --force` on stdin. So what
Vercel stores is byte-for-byte what just connected, with the user name and
password percent-encoded. If the test fails, Vercel is left unchanged.
Nothing secret is printed or passed on a command line.

Needs the Vercel CLI logged in and frontend/ linked (`vercel link`). A changed
variable only reaches the site on the next deployment: redeploy afterwards.
"""

from __future__ import annotations

import argparse
import getpass
import subprocess
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit

import psycopg

FRONTEND = Path(__file__).resolve().parent.parent.parent / "frontend"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--target", default="production", choices=["production", "preview"])
    ap.add_argument("--schema", default="tenant_owner", help="tenant schema to count nodes in")
    args = ap.parse_args()

    url = getpass.getpass("  DATABASE_URL (hidden): ").strip()
    u = urlsplit(url)
    user, pw = unquote(u.username or ""), unquote(u.password or "")
    if not (u.hostname and user and pw):
        raise SystemExit("  that does not look like postgresql://user:password@host:port/db")

    try:
        with psycopg.connect(
            host=u.hostname, port=u.port or 5432, user=user, password=pw,
            dbname=u.path.lstrip("/") or "postgres", sslmode="require", connect_timeout=15,
        ) as con:
            n = con.execute(f'SELECT COUNT(*) FROM "{args.schema}".nodes').fetchone()[0]
    except psycopg.Error as exc:
        last = str(exc).strip().splitlines()[-1]
        raise SystemExit(f"  login FAILED, Vercel left unchanged: {last}") from None
    print(f"  login OK as {user}; {args.schema}.nodes = {n}")

    netloc = f"{quote(user, safe='')}:{quote(pw, safe='')}@{u.hostname}:{u.port or 5432}"
    clean = urlunsplit((u.scheme, netloc, u.path or "/postgres", u.query, ""))

    res = subprocess.run(
        ["vercel", "env", "add", "DATABASE_URL", args.target, "--sensitive", "--force", "--yes"],
        input=clean, text=True, cwd=FRONTEND, capture_output=True, check=False,
    )
    tail = (res.stdout + res.stderr).strip().splitlines()[-3:]
    print("  vercel:", " | ".join(line.strip() for line in tail))
    if res.returncode != 0:
        print("  vercel env add FAILED")
        return 1
    print(f"  stored in Vercel {args.target}; redeploy for it to take effect")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
