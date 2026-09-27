#!/usr/bin/env python3
"""Check a Supabase pooler knows your project and user, without knowing the password.

    ~/cgvenv/bin/python tests/diagnostics/probe_pooler.py
    ~/cgvenv/bin/python tests/diagnostics/probe_pooler.py --user codegraph_app.<ref>

Logs in to both pooler ports (5432 session, 6543 transaction) with a
deliberately wrong password and reads the refusal:

  password authentication failed   host, project ref and user all exist: good
  Tenant or user not found         wrong project ref, region host, or user name
  timeout / could not translate    network or DNS problem (wrong host?)

Defaults come from src/code_graph/pgcli.py, i.e. the project the admin scripts use.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "src"))

import psycopg

from code_graph import pgcli


def verdict(message: str) -> str:
    if "password authentication failed" in message:
        return "OK: project and user exist (the wrong password was refused, as intended)"
    if "Tenant or user not found" in message:
        return "WRONG project ref, region host or user name"
    if "timeout" in message or "translate host" in message:
        return "NETWORK: host unreachable or does not resolve"
    return "UNEXPECTED: read the message"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    pgcli.add_connection_args(ap)
    args = ap.parse_args()
    print(f"\n  probing {args.user}@{args.host}\n")
    for port in (5432, 6543):
        try:
            psycopg.connect(
                host=args.host, port=port, user=args.user, dbname=args.db,
                password="deliberately-wrong", sslmode="require", connect_timeout=15,
            ).close()
            print(f"  {port}: connected with a dummy password?! check the role's auth setup")
        except psycopg.Error as exc:
            msg = str(exc).strip().splitlines()[-1]
            print(f"  {port}: {verdict(msg)}\n        {msg}")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
