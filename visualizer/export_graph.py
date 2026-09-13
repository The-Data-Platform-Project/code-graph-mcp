#!/usr/bin/env python3
"""Export graph.db to graph-data.json for the static visualizer.

Usage:
    python export_graph.py [path/to/graph.db] [output.json]

Exports ALL nodes from every repo (with a per-repo cap for very large repos)
so that no repository is crowded out by another.
"""
import json
import sqlite3
import sys
from pathlib import Path

MAX_NODES_PER_REPO = 3000


def export(db_path: str, out_path: str) -> None:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    repos = [dict(r) for r in con.execute("SELECT * FROM repos ORDER BY name").fetchall()]

    # Fetch nodes per-repo so every repo is represented
    nodes = []
    for repo in repos:
        rows = con.execute(
            "SELECT id, repo, kind, name, qualified_name, file_path, "
            "start_line, end_line, signature FROM nodes "
            "WHERE repo = ? ORDER BY kind, name LIMIT ?",
            (repo["name"], MAX_NODES_PER_REPO),
        ).fetchall()
        nodes.extend(dict(r) for r in rows)

    qnames = {n["qualified_name"] for n in nodes}

    all_edges = con.execute(
        "SELECT repo, edge_type, src_qname, dst_qname FROM edges"
    ).fetchall()
    all_links = [
        {"source": r["src_qname"], "target": r["dst_qname"], "type": r["edge_type"], "repo": r["repo"]}
        for r in all_edges
        if r["src_qname"] in qnames and r["dst_qname"] in qnames
    ]

    graph_nodes = [
        {
            "id": n["qualified_name"],
            "name": n["name"],
            "kind": n["kind"],
            "repo": n["repo"],
            "file_path": n["file_path"],
            "start_line": n["start_line"],
            "signature": n["signature"],
        }
        for n in nodes
    ]

    resolved_links = [l for l in all_links if l["type"] != "CONTAINS"]

    data = {
        "nodes": graph_nodes,
        "links": all_links,
        "repos": repos,
        "stats": {
            "nodes": len(graph_nodes),
            "edges": len(resolved_links),
            "files": len({n["file_path"] for n in nodes}),
        },
    }

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(data), encoding="utf-8")
    con.close()

    print(f"Exported {len(repos)} repos:")
    for repo in repos:
        cnt = sum(1 for n in graph_nodes if n["repo"] == repo["name"])
        print(f"  {repo['name']}: {cnt} nodes")
    print(f"Total: {data['stats']['nodes']} nodes, {len(all_links)} edges → {out_path}")


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent.parent / "data" / "graph.db")
    out = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).resolve().parent / "graph-data.json")
    export(db, out)
