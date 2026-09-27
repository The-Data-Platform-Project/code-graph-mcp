#!/usr/bin/env python3
"""Create, list and revoke the bearer tokens Claude Code uses for /api/mcp.

    python scripts/mcp_token.py create --tenant owner --label desktop
    python scripts/mcp_token.py list [--tenant owner]
    python scripts/mcp_token.py revoke 3

A token grants read access to exactly one tenant's graph. It is printed once,
at creation, and only its SHA-256 is stored — a lost token is revoked and
replaced, never recovered. Connection options are the loader's: the Supabase
session pooler by default, or $DATABASE_URL / --dsn.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import psycopg  # noqa: E402

from code_graph import control, pgcli  # noqa: E402


def _when(value) -> str:
    return value.strftime("%Y-%m-%d %H:%M") if value else "-"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    pgcli.add_connection_args(ap)
    sub = ap.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create", help="mint a token for a tenant")
    create.add_argument("--tenant", default="owner")
    create.add_argument("--label", default="", help="where it is used, e.g. desktop")
    lst = sub.add_parser("list", help="list tokens (never the tokens themselves)")
    lst.add_argument("--tenant")
    revoke = sub.add_parser("revoke", help="revoke a token by id")
    revoke.add_argument("id", type=int)
    args = ap.parse_args()

    try:
        with pgcli.connect(args) as con:
            if args.command == "create":
                raw = control.create_token(con, args.tenant, args.label)
                print(f"\n  token for tenant {args.tenant!r} (shown once — store it now):\n")
                print(f"    {raw}\n")
                print("  Claude Code reads it from CODE_GRAPH_TOKEN (see docs/ADMIN_GUIDE.md).\n")
            elif args.command == "list":
                rows = control.list_tokens(con, args.tenant)
                if not rows:
                    print("  no tokens")
                for r in rows:
                    state = f"revoked {_when(r['revoked_at'])}" if r["revoked_at"] else "live"
                    print(f"  {r['id']:>4}  {r['tenant']:<16} {r['token_prefix']}…  "
                          f"{r['label'] or '-':<14} created {_when(r['created_at'])}  "
                          f"used {_when(r['last_used_at'])}  {state}")
            else:
                if not control.revoke_token(con, args.id):
                    print(f"  no live token with id {args.id}", file=sys.stderr)
                    return 1
                print(f"  revoked token {args.id}")
    except LookupError as exc:
        print(f"  {exc}", file=sys.stderr)
        return 1
    except psycopg.errors.UndefinedTable:
        print("  no control schema here yet — run scripts/load_sqlite_to_supabase.py first",
              file=sys.stderr)
        return 1
    except psycopg.Error as exc:
        print(f"  database error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
