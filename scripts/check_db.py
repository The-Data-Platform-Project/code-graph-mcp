#!/usr/bin/env python3
"""Check that DATABASE_URL is reachable, and say precisely why if it is not.

The Supabase failure modes all look alike from the application — a hang, or an
auth error that reads like a wrong password — so this reports the specific
cause: IPv6-only host, wrong pooler username, missing TLS, absent schema.

    python scripts/check_db.py
    DATABASE_URL=postgresql://... python scripts/check_db.py
"""

from __future__ import annotations

import os
import socket
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import psycopg  # noqa: E402

from code_graph.config import Config  # noqa: E402

_TABLES = ("repos", "nodes", "edges", "files", "imports")


def _families(host: str) -> set[str]:
    try:
        info = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return set()
    return {"IPv6" if i[0] == socket.AF_INET6 else "IPv4" for i in info}


def main() -> int:
    dsn = os.environ.get("DATABASE_URL") or Config.from_env().database_url
    parts = urlsplit(dsn)
    host, port, user = parts.hostname or "", parts.port or 5432, parts.username or ""

    # A unix-socket DSN carries the directory in `?host=`, not in the authority.
    is_socket = not host or host.startswith("/")
    print(f"host  {host + ':' + str(port) if host else 'local socket'}")
    print(f"user  {user}")

    families = set() if is_socket else _families(host)
    if not is_socket:
        print(f"dns   {', '.join(sorted(families)) if families else 'DOES NOT RESOLVE'}")

    if families == {"IPv6"}:
        print(
            "\n  ! IPv6-only. Docker's default bridge network is IPv4, so a\n"
            "    container cannot reach this host. Use the pooler instead:\n"
            "    aws-<n>-<region>.pooler.supabase.com with user postgres.<ref>",
        )
    if "supabase" in host and "pooler" in host and "." not in user:
        print(
            "\n  ! Pooler connections need the username postgres.<project-ref>,\n"
            f"    not '{user}'. Authentication will fail otherwise.",
        )

    try:
        with psycopg.connect(dsn, connect_timeout=10) as con:
            version = con.execute("SELECT version()").fetchone()[0]
            print(f"\nconnected\n  {version.split(',')[0]}")
            present = {
                r[0]
                for r in con.execute(
                    "SELECT table_name FROM information_schema.tables "
                    "WHERE table_schema = current_schema()"
                ).fetchall()
            }
            missing = [t for t in _TABLES if t not in present]
            if missing:
                print(f"  schema: missing {', '.join(missing)} — index a repo to create it")
            else:
                rows = con.execute(
                    "SELECT name, node_count, edge_count FROM repos ORDER BY name"
                ).fetchall()
                print(f"  schema: all {len(_TABLES)} tables present")
                for name, nodes, edges in rows:
                    print(f"    {name}: {nodes} nodes, {edges} edges")
                if not rows:
                    print("    (no repositories indexed yet)")
    except Exception as exc:
        print(f"\nFAILED: {type(exc).__name__}: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
