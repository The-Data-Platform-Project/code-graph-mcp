#!/usr/bin/env python3
"""Look inside a SQLite graph before loading it: what repos it holds, and what won't fit.

    ~/cgvenv/bin/python tests/diagnostics/inspect_sqlite_graph.py
    ~/cgvenv/bin/python tests/diagnostics/inspect_sqlite_graph.py path/to/graph.db --repo care-pk

Reports, read-only:
  - every repo with its indexed path and counts; a path of `.` means it was
    indexed from the root of the mount (the whole drive), which is almost never
    what you want in the cloud;
  - the top-level directories of any such repo (or of --repo), so you can see
    what it really contains;
  - values too large for a Postgres btree index (limit 2704 bytes per index
    row), which make `load_sqlite_to_supabase.py` fail with "index row size ...
    exceeds btree version 4 maximum", and which repos they are in;
  - inline `data:` URIs recorded as imports (the usual cause of the above);
  - a suggested `--exclude` list for the loader.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

# Columns that sit in a Postgres btree index or primary key (src/code_graph/db.py).
INDEXED = [
    ("nodes", "qualified_name"), ("nodes", "name"), ("nodes", "file_path"),
    ("edges", "src_qname"), ("edges", "dst_qname"), ("edges", "src_file"),
    ("imports", "file_path"), ("imports", "local_name"), ("files", "path"),
]
# Stay clear of 2704: the index row also carries the repo and edge type.
LIMIT = 2000


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("sqlite", nargs="?", default=str(ROOT / "data" / "graph.db"))
    ap.add_argument("--repo", action="append", default=[],
                    help="also list this repo's top-level directories; repeatable")
    args = ap.parse_args()

    path = Path(args.sqlite)
    if not path.is_file():
        raise SystemExit(f"no SQLite file at {path}")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    q = con.execute

    print(f"\n  {path}\n\n  repos")
    suspicious = []
    for name, rpath, when, n, e, f in q(
        "SELECT name, path, indexed_at, node_count, edge_count, file_count FROM repos ORDER BY name"
    ):
        flag = "   <- indexed from the mount root" if rpath in (".", "", "/") else ""
        print(f"    {name:<24} {n:>6} nodes {e:>7} edges {f:>5} files  path={rpath!r}  {when}{flag}")
        if flag:
            suspicious.append(name)

    for repo in dict.fromkeys(suspicious + args.repo):
        print(f"\n  top-level directories in {repo}")
        for top, count in q(
            "SELECT CASE WHEN instr(path,'/')>0 THEN substr(path,1,instr(path,'/')-1) "
            "ELSE path END AS top, COUNT(*) FROM files WHERE repo = ? "
            "GROUP BY top ORDER BY 2 DESC LIMIT 20", (repo,)
        ):
            print(f"    {count:>6}  {top}")

    print(f"\n  values over {LIMIT} bytes in indexed columns (Postgres btree limit is 2704)")
    offenders: set[str] = set()
    found = False
    for table, col in INDEXED:
        for repo, count, longest in q(
            f"SELECT repo, COUNT(*), MAX(LENGTH(CAST({col} AS BLOB))) FROM {table} "
            f"WHERE LENGTH(CAST({col} AS BLOB)) > ? GROUP BY repo", (LIMIT,)
        ):
            found = True
            offenders.add(repo)
            print(f"    {table}.{col:<15} {repo:<24} {count:>4} rows, longest {longest} bytes")
    if not found:
        print("    none: the graph fits")

    rows = q(
        "SELECT repo, COUNT(*) FROM edges WHERE dst_raw LIKE 'data:%' GROUP BY repo"
    ).fetchall()
    if rows:
        print("\n  inline data: URIs recorded as imports (the extractor skips these now)")
        for repo, count in rows:
            print(f"    {repo:<24} {count}")

    exclude = sorted(set(suspicious) | offenders)
    print()
    if exclude:
        print("  suggested:  scripts/load_sqlite_to_supabase.py "
              + " ".join(f"--exclude {r}" for r in exclude))
    else:
        print("  nothing to exclude")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
