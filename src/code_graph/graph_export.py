"""Build the visualizer's graph payload from the SQLite graph.

One source of truth for two consumers: the live `/api/graph` endpoint (see
`web.py`) and `visualizer/export_graph.py`, which writes the same payload to
`graph-data.json` for opening the visualizer straight off disk.

Nodes are fetched per repo under a fixed cap so a single large repository
cannot crowd every other one out of the picture.
"""

from __future__ import annotations

import sqlite3
from typing import Any

MAX_NODES_PER_REPO = 3000


def build_payload(
    con: sqlite3.Connection, max_nodes_per_repo: int = MAX_NODES_PER_REPO
) -> dict[str, Any]:
    """Return the {nodes, links, repos, stats} payload the visualizer consumes."""
    repos = [
        dict(r) for r in con.execute("SELECT * FROM repos ORDER BY name").fetchall()
    ]

    nodes: list[dict[str, Any]] = []
    for repo in repos:
        rows = con.execute(
            "SELECT repo, kind, name, qualified_name, file_path, start_line, "
            "end_line, signature FROM nodes WHERE repo = ? ORDER BY kind, name LIMIT ?",
            (repo["name"], max_nodes_per_repo),
        ).fetchall()
        nodes.extend(
            {
                "id": r["qualified_name"],
                "name": r["name"],
                "kind": r["kind"],
                "repo": r["repo"],
                "file_path": r["file_path"],
                "start_line": r["start_line"],
                "end_line": r["end_line"],
                "signature": r["signature"],
            }
            for r in rows
        )

    qnames = {n["id"] for n in nodes}
    links = [
        {
            "source": r["src_qname"],
            "target": r["dst_qname"],
            "type": r["edge_type"],
            "repo": r["repo"],
        }
        for r in con.execute(
            "SELECT repo, edge_type, src_qname, dst_qname FROM edges"
        ).fetchall()
        if r["src_qname"] in qnames and r["dst_qname"] in qnames
    ]

    return {
        "nodes": nodes,
        "links": links,
        "repos": repos,
        "stats": {
            "nodes": len(nodes),
            "edges": sum(1 for link in links if link["type"] != "CONTAINS"),
            "files": len({n["file_path"] for n in nodes}),
        },
    }
