#!/usr/bin/env python3
"""Export graph.db to graph-data.json for opening the visualizer off disk.

Usage:
    python export_graph.py [path/to/graph.db] [output.json]

Only needed for the static, file:// way of using the visualizer. When the
service is running, open http://127.0.0.1:8765/ instead: the page reads the
same payload live from /api/graph, and README/source previews work there
(they need the server to read files from the workspaces mount).

The payload itself is built by `code_graph.graph_export`, shared with the
live endpoint so the two can never drift apart.
"""
import json
import sqlite3
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "src"))

from code_graph import graph_export  # noqa: E402


def export(db_path: str, out_path: str) -> None:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    try:
        data = graph_export.build_payload(con)
    finally:
        con.close()

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(data), encoding="utf-8")

    print(f"Exported {len(data['repos'])} repos:")
    for repo in data["repos"]:
        count = sum(1 for n in data["nodes"] if n["repo"] == repo["name"])
        print(f"  {repo['name']}: {count} nodes")
    print(
        f"Total: {data['stats']['nodes']} nodes, "
        f"{len(data['links'])} edges → {out_path}"
    )


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else str(_ROOT / "data" / "graph.db")
    out = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).resolve().parent / "graph-data.json")
    export(db, out)
