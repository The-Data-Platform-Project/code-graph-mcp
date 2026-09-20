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
from .models import EDGE_CALLS, EDGE_IMPORTS
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


# ── Preview support ────────────────────────────────────────────────────────
# Backing the visualizer's README / file / symbol previews. Like
# `get_code_snippet`, these read fresh from disk through `safe_join`: the DB
# holds structure only, never source text.

_MAX_SOURCE_BYTES = 1_000_000
_README_RANK = {".md": 0, ".markdown": 1, ".rst": 2, ".txt": 3, "": 4}


def _repo_rel_path(con: sqlite3.Connection, repo: str) -> Optional[str]:
    row = con.execute("SELECT path FROM repos WHERE name = ?", (repo,)).fetchone()
    return row["path"] if row is not None else None


def _read_text_capped(path: Path, max_bytes: Optional[int] = None) -> dict[str, Any]:
    """Read at most `max_bytes` of `path` as text, refusing binary content.

    Truncation stops at the last newline so the preview never ends mid-line.
    """
    if max_bytes is None:
        max_bytes = _MAX_SOURCE_BYTES
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            data = fh.read(max_bytes)
    except OSError as exc:
        return {"found": False, "error": f"could not read file: {exc}"}
    if b"\x00" in data[:8192]:
        return {"found": False, "error": "binary file; nothing to preview"}
    truncated = size > len(data)
    text = data.decode("utf-8", errors="replace")
    if truncated:
        cut = text.rfind("\n")
        if cut > 0:
            text = text[:cut]
    return {
        "found": True,
        "content": text,
        "bytes": size,
        "truncated": truncated,
        "line_count": text.count("\n") + 1 if text else 0,
    }


def get_repo_readme(
    con: sqlite3.Connection, config: Config, repo: str
) -> dict[str, Any]:
    """Return the README at the root of `repo`, read fresh from disk."""
    rel = _repo_rel_path(con, repo)
    if rel is None:
        return {"found": False, "error": f"repo {repo!r} is not indexed"}
    try:
        root = safe_join(config.workspaces_root, rel)
    except ValueError as exc:
        return {"found": False, "error": str(exc)}
    if not root.is_dir():
        return {"found": False, "error": f"repo directory not present: {rel!r}"}

    candidates = []
    try:
        for entry in root.iterdir():
            if entry.is_file() and entry.stem.lower() == "readme":
                candidates.append(entry)
    except OSError as exc:
        return {"found": False, "error": f"could not list repo root: {exc}"}
    if not candidates:
        return {"found": False, "error": "no README at the repository root"}

    best = min(candidates, key=lambda p: (_README_RANK.get(p.suffix.lower(), 9), p.name))
    result = _read_text_capped(best)
    if not result["found"]:
        return result
    return {**result, "repo": repo, "file_path": best.name, "format": best.suffix.lower()}


def get_file_source(
    con: sqlite3.Connection,
    config: Config,
    repo: str,
    file_path: str,
    repo_rel: Optional[str] = None,
) -> dict[str, Any]:
    """Return the full text of a repo-relative file, confined to the repo root."""
    rel = repo_rel if repo_rel is not None else _repo_rel_path(con, repo)
    if rel is None:
        return {"found": False, "error": f"repo {repo!r} is not indexed"}
    try:
        # Two steps on purpose: `file_path` arrives from the caller, so it is
        # confined to this repo's root rather than to the whole workspaces
        # mount — otherwise "../other-repo/secret" would still resolve inside
        # the mount and be served.
        repo_root = safe_join(config.workspaces_root, rel)
        abs_path = safe_join(repo_root, file_path)
    except ValueError as exc:
        return {"found": False, "error": str(exc)}
    if not abs_path.is_file():
        return {"found": False, "error": f"file not found on disk: {file_path}"}
    result = _read_text_capped(abs_path)
    if not result["found"]:
        return result
    return {**result, "repo": repo, "file_path": file_path}


def get_dependents(
    con: sqlite3.Connection, repo: str, file_path: str
) -> list[dict[str, Any]]:
    """Return the files importing anything defined in `file_path`.

    The inverse of `get_dependencies`, matched through the imported *symbol*
    rather than the module name: a Python `from .utils import helper` records
    `pkg.utils.helper` as its target, so asking only about `pkg.utils` would
    miss every importer.
    """
    rows = con.execute(
        "SELECT DISTINCT e.src_file, e.dst_qname FROM edges e "
        "JOIN nodes n ON n.repo = e.repo AND n.qualified_name = e.dst_qname "
        "WHERE e.edge_type = ? AND e.resolved = 1 AND e.repo = ? "
        "AND n.file_path = ? AND e.src_file != ? "
        "ORDER BY e.src_file LIMIT 200",
        (EDGE_IMPORTS, repo, file_path, file_path),
    ).fetchall()
    return [
        {"repo": repo, "file_path": r["src_file"], "imported": r["dst_qname"]}
        for r in rows
    ]


def get_file_symbols(
    con: sqlite3.Connection, repo: str, file_path: str, exclude: Optional[str] = None
) -> list[dict[str, Any]]:
    """Return the symbols defined in one file, for 'what else lives here' context."""
    rows = con.execute(
        "SELECT kind, name, qualified_name, start_line, signature FROM nodes "
        "WHERE repo = ? AND file_path = ? AND kind != 'File' "
        "ORDER BY start_line LIMIT 200",
        (repo, file_path),
    ).fetchall()
    return [dict(r) for r in rows if r["qualified_name"] != exclude]


def get_node_context(
    con: sqlite3.Connection,
    config: Config,
    qualified_name: str,
    repo: Optional[str] = None,
) -> dict[str, Any]:
    """Everything the preview panel needs for one node.

    The node itself plus its source (the symbol's own lines and the whole file
    it lives in) and its connected files and functions: callers, callees, the
    imports of its file, the files importing it, and its sibling definitions.
    """
    node = find_node(con, qualified_name, repo)
    if node is None:
        return {"found": False, "error": f"no node named {qualified_name!r}"}

    node_repo = node["repo"]
    rel = _repo_rel_path(con, node_repo)
    if rel is None:
        return {"found": False, "error": f"repo {node_repo!r} not registered"}

    source = get_file_source(con, config, node_repo, node["file_path"], repo_rel=rel)
    info = {
        "repo": node_repo,
        "kind": node["kind"],
        "name": node["name"],
        "qualified_name": node["qualified_name"],
        "file_path": node["file_path"],
        "start_line": node["start_line"],
        "end_line": node["end_line"],
        "signature": node["signature"],
    }
    return {
        "found": True,
        "node": info,
        "source": source,
        "callers": get_callers(con, node["qualified_name"], node_repo),
        "callees": get_callees(con, node["qualified_name"], node_repo),
        "dependencies": get_dependencies(con, node["file_path"], node_repo),
        "dependents": get_dependents(con, node_repo, node["file_path"]),
        "siblings": get_file_symbols(
            con, node_repo, node["file_path"], exclude=node["qualified_name"]
        ),
    }
