#!/usr/bin/env python3
"""Load the SQLite code graph into a tenant schema on Supabase (or any Postgres).

    python scripts/load_sqlite_to_supabase.py
    python scripts/load_sqlite_to_supabase.py --sqlite data/graph.db --tenant owner \\
        --github data-platform=The-Data-Platform-Project/data-platform

Creates, all in one transaction:
  - the `control` schema (tenants, MCP tokens, repo connections)
  - a tenant row and its schema, `tenant_<slug>`, holding the graph tables
  - the graph rows, copied from SQLite
  - repo connections from --github, so the app can fetch source from GitHub

If anything fails, nothing is committed. It refuses to overwrite an existing
graph without --replace, and refuses an empty SQLite file outright.

Connects to your Supabase **session pooler** by default (IPv4, port 5432) —
the direct db.<ref>.supabase.co host is IPv6-only, and the transaction pooler
(6543) does not suit one long transaction. The password is prompted for and
never echoed. Set DATABASE_URL or pass --dsn to point anywhere else.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402

from code_graph import sqlite_import  # noqa: E402
from code_graph.control import schema_for  # noqa: E402


def parse_github(values: list[str]) -> list[tuple[str, str, str | None]]:
    out = []
    for raw in values:
        name, sep, target = raw.partition("=")
        if not sep or "/" not in target:
            raise SystemExit(f"--github expects REPO=owner/name[@ref], got {raw!r}")
        external, _, ref = target.partition("@")
        out.append((name, external, ref or None))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--sqlite", default=str(ROOT / "data" / "graph.db"),
                    help="SQLite graph file (default: data/graph.db)")
    ap.add_argument("--tenant", default="owner", help="tenant slug (default: owner)")
    ap.add_argument("--display-name", default="Owner", help="tenant display name")
    ap.add_argument("--github", action="append", default=[], metavar="REPO=OWNER/NAME[@REF]",
                    help="map a graph repo to its GitHub repo, for source previews; repeatable")
    ap.add_argument("--replace", action="store_true",
                    help="overwrite the tenant's existing graph")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"),
                    help="full connection string (default: $DATABASE_URL, else Supabase)")
    ap.add_argument("--host", default="aws-0-ap-southeast-2.pooler.supabase.com")
    ap.add_argument("--port", default="5432")
    ap.add_argument("--user", default="postgres.rkeuovfdmmjebechozev")
    ap.add_argument("--db", default="postgres")
    ap.add_argument("-y", "--yes", action="store_true", help="skip the confirmation prompt")
    args = ap.parse_args()

    connections = parse_github(args.github)
    sqlite_path = Path(args.sqlite)
    try:
        lite = sqlite_import.open_sqlite(sqlite_path)
        counts = sqlite_import.sqlite_counts(lite)
        repos = [r[0] for r in lite.execute("SELECT name FROM repos ORDER BY name")]
        lite.close()
    except sqlite_import.LoadError as exc:
        print(f"  {exc}", file=sys.stderr)
        return 1

    target = "DATABASE_URL" if args.dsn else f"{args.user}@{args.host}:{args.port}/{args.db}"
    print(f"\n  from    {sqlite_path}")
    print(f"          {counts['repos']} repos ({', '.join(repos)}), "
          f"{counts['nodes']} nodes, {counts['edges']} edges")
    print(f"  to      {target}, schema {schema_for(args.tenant)}")
    for name, external, ref in connections:
        print(f"  github  {name} -> {external}{'@' + ref if ref else ''}")
    unmapped = sorted(set(repos) - {c[0] for c in connections})
    if unmapped:
        print(f"  note    no --github for {', '.join(unmapped)}: the graph will load, "
              "but source previews for those repos will be unavailable")
    print()

    if not args.yes and input("  Proceed? [y/N] ").strip().lower() != "y":
        print("  aborted")
        return 1

    if args.dsn:
        conninfo = {"conninfo": args.dsn}
    else:
        conninfo = {
            "host": args.host, "port": args.port, "user": args.user, "dbname": args.db,
            "password": getpass.getpass(f"  Password for {args.user}: "),
            "sslmode": "require", "connect_timeout": 15,
        }

    try:
        with psycopg.connect(row_factory=dict_row, **conninfo) as pg:
            loaded = sqlite_import.load(
                sqlite_path, pg, args.tenant, args.display_name,
                replace=args.replace, connections=connections,
            )
    except sqlite_import.LoadError as exc:
        print(f"\n  {exc}\n  Nothing was committed.", file=sys.stderr)
        return 1
    except psycopg.Error as exc:
        print(f"\n  database error: {exc}\n  Nothing was committed.", file=sys.stderr)
        return 1

    print("  loaded, and verified against the source:")
    for table, n in loaded.items():
        print(f"    {table:<8} {n}")
    print(f"\n  Next: create an MCP token for this tenant —\n"
          f"    python scripts/mcp_token.py create --tenant {args.tenant} --label desktop\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
