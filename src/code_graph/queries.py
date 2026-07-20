"""Read-side graph queries backing the MCP tools.

Every function takes an open connection and returns plain JSON-serializable
dicts/lists. Qualified-name lookups are optionally scoped to a repo; when no
repo is given they match across all indexed repos (results carry their repo).
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Optional

from .config import Config
from .models import EDGE_CALLS
from .util import like_pattern, safe_join

# Kinds returned by symbol search. Config/Service files are included so config
# and compose services are findable; plain code `File` nodes are excluded to keep
# search from being flooded with every source file in the repo.
_SYMBOL_KINDS = ("Class", "Function", "Method", "Interface", "Config", "Service")
_MAX_TRACE_NODES = 500
_MAX_TRACE_BREADTH = 50


def list_repositories(con: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = con.execute(
        "SELECT name, path, indexed_at, node_count, edge_count, file_count "
        "FROM repos ORDER BY name"
    ).fetchall()
    return [dict(r) for r in rows]


def search_symbol(
    con: sqlite3.Connection,
    pattern: str,
    repo: Optional[str] = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    like = like_pattern(pattern)
    placeholders = ",".join("?" * len(_SYMBOL_KINDS))
    sql = (
        "SELECT repo, kind, name, qualified_name, file_path, start_line, signature "
        "FROM nodes WHERE kind IN ({}) "
        "AND (name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\')"
    ).format(placeholders)
    params: list[Any] = [*_SYMBOL_KINDS, like, like]
    if repo:
        sql += " AND repo = ?"
        params.append(repo)
    sql += " ORDER BY name LIMIT ?"
    params.append(limit)
    return [dict(r) for r in con.execute(sql, params).fetchall()]


def get_callers(
    con: sqlite3.Connection, qualified_name: str, repo: Optional[str] = None
) -> list[dict[str, Any]]:
    sql = (
        "SELECT n.repo, n.kind, n.qualified_name, n.file_path, n.start_line, "
        "n.signature FROM edges e "
        "JOIN nodes n ON n.repo = e.repo AND n.qualified_name = e.src_qname "
        "WHERE e.edge_type = ? AND e.dst_qname = ? AND e.resolved = 1"
    )
    params: list[Any] = [EDGE_CALLS, qualified_name]
    if repo:
        sql += " AND e.repo = ?"
        params.append(repo)
    sql += " ORDER BY n.repo, n.qualified_name"
    seen = set()
    out = []
    for r in con.execute(sql, params).fetchall():
        key = (r["repo"], r["qualified_name"])
        if key not in seen:
            seen.add(key)
            out.append(dict(r))
    return out


def get_callees(
    con: sqlite3.Connection, qualified_name: str, repo: Optional[str] = None
) -> list[dict[str, Any]]:
    sql = (
        "SELECT e.dst_qname, e.dst_raw, e.resolved, e.repo, "
        "n.kind, n.file_path, n.start_line, n.signature FROM edges e "
        "LEFT JOIN nodes n ON n.repo = e.repo AND n.qualified_name = e.dst_qname "
        "WHERE e.edge_type = ? AND e.src_qname = ?"
    )
    params: list[Any] = [EDGE_CALLS, qualified_name]
    if repo:
        sql += " AND e.repo = ?"
        params.append(repo)
    sql += " ORDER BY e.resolved DESC, e.dst_qname"
    out = []
    seen = set()
    for r in con.execute(sql, params).fetchall():
        target = r["dst_qname"] if r["resolved"] else r["dst_raw"]
        key = (r["repo"], target, bool(r["resolved"]))
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "repo": r["repo"],
                "callee": target,
                "resolved": bool(r["resolved"]),
                "kind": r["kind"],
                "file_path": r["file_path"],
                "start_line": r["start_line"],
                "signature": r["signature"],
            }
        )
    return out


def trace_call_path(
    con: sqlite3.Connection,
    qualified_name: str,
    direction: str = "callees",
    depth: int = 3,
    repo: Optional[str] = None,
) -> dict[str, Any]:
    if direction not in ("callees", "callers"):
        raise ValueError("direction must be 'callees' or 'callers'")
    depth = max(1, min(int(depth), 20))

    if direction == "callees":
        sql = (
            "SELECT DISTINCT dst_qname AS nb FROM edges "
            "WHERE edge_type = ? AND src_qname = ? AND resolved = 1"
        )
    else:
        sql = (
            "SELECT DISTINCT src_qname AS nb FROM edges "
            "WHERE edge_type = ? AND dst_qname = ? AND resolved = 1"
        )
    repo_clause = " AND repo = ?" if repo else ""

    visited: set[str] = {qualified_name}
    total = [0]
    truncated = [False]

    def neighbors(name: str) -> list[str]:
        params: list[Any] = [EDGE_CALLS, name]
        if repo:
            params.append(repo)
        rows = con.execute(sql + repo_clause, params).fetchall()
        return [r["nb"] for r in rows]

    def expand(name: str, level: int) -> dict[str, Any]:
        node: dict[str, Any] = {"qualified_name": name}
        if level >= depth:
            return node
        children = []
        for nb in neighbors(name):
            if total[0] >= _MAX_TRACE_NODES or len(children) >= _MAX_TRACE_BREADTH:
                truncated[0] = True
                break
            if nb in visited:
                children.append({"qualified_name": nb, "cycle": True})
                continue
            visited.add(nb)
            total[0] += 1
            children.append(expand(nb, level + 1))
        if children:
            node["children"] = children
        return node

    tree = expand(qualified_name, 0)
    return {
        "root": qualified_name,
        "direction": direction,
        "depth": depth,
        "repo": repo,
        "nodes_visited": total[0],
        "truncated": truncated[0],
        "tree": tree,
    }


def get_dependencies(
    con: sqlite3.Connection, file_path: str, repo: Optional[str] = None
) -> list[dict[str, Any]]:
    file_path = file_path.replace("\\", "/")
    sql = (
        "SELECT i.repo, i.local_name, i.target, i.kind, "
        "EXISTS(SELECT 1 FROM nodes n WHERE n.repo = i.repo "
        "AND n.qualified_name = i.target) AS in_project "
        "FROM imports i WHERE i.file_path = ?"
    )
    params: list[Any] = [file_path]
    if repo:
        sql += " AND i.repo = ?"
        params.append(repo)
    sql += " ORDER BY i.repo, i.target"
    return [
        {
            "repo": r["repo"],
            "local_name": r["local_name"],
            "target": r["target"],
            "kind": r["kind"],
            "in_project": bool(r["in_project"]),
        }
        for r in con.execute(sql, params).fetchall()
    ]


def find_node(
    con: sqlite3.Connection, qualified_name: str, repo: Optional[str] = None
) -> Optional[sqlite3.Row]:
    sql = (
        "SELECT repo, kind, name, qualified_name, file_path, start_line, end_line, "
        "signature FROM nodes WHERE qualified_name = ?"
    )
    params: list[Any] = [qualified_name]
    if repo:
        sql += " AND repo = ?"
        params.append(repo)
    # Prefer a concrete definition over a File node when names collide.
    sql += " ORDER BY CASE kind WHEN 'File' THEN 1 ELSE 0 END LIMIT 1"
    return con.execute(sql, params).fetchone()


def get_code_snippet(
    con: sqlite3.Connection,
    config: Config,
    qualified_name: str,
    repo: Optional[str] = None,
) -> dict[str, Any]:
    node = find_node(con, qualified_name, repo)
    if node is None:
        return {"error": f"no node named {qualified_name!r}", "found": False}
    repo_row = con.execute(
        "SELECT path FROM repos WHERE name = ?", (node["repo"],)
    ).fetchone()
    if repo_row is None:
        return {"error": f"repo {node['repo']!r} not registered", "found": False}

    try:
        abs_path = safe_join(config.workspaces_root, repo_row["path"], node["file_path"])
    except ValueError as exc:
        return {"error": str(exc), "found": False}
    if not abs_path.is_file():
        return {
            "error": f"source file not found on disk: {node['file_path']}",
            "found": False,
        }

    start = node["start_line"]
    end = node["end_line"]
    try:
        text = abs_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return {"error": f"could not read file: {exc}", "found": False}
    lines = text.splitlines()
    snippet = "\n".join(lines[start - 1 : end])
    return {
        "found": True,
        "repo": node["repo"],
        "qualified_name": node["qualified_name"],
        "kind": node["kind"],
        "file_path": node["file_path"],
        "start_line": start,
        "end_line": end,
        "signature": node["signature"],
        "code": snippet,
    }
