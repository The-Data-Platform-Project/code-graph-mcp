"""FastMCP server exposing the code graph over streamable HTTP.

Transport: streamable HTTP, mounted at `/mcp` (FastMCP's default). The container
binds 0.0.0.0:8765 internally; docker-compose publishes it only to the host's
127.0.0.1, so the service is reachable from this machine and nowhere else.

This module is the trust boundary for the read-only workspaces mount: repo paths
from tool arguments are confined to WORKSPACES_ROOT via `safe_join` before any
file is touched.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP

from . import db, queries, web
from .config import Config
from .indexer import Indexer
from .util import safe_join

_CONFIG = Config.from_env()
_INDEXER = Indexer(_CONFIG)
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")

mcp = FastMCP(
    "code-graph",
    host=_CONFIG.host,
    port=_CONFIG.port,
    instructions=(
        "A persistent code knowledge graph. Index repositories under the "
        "read-only /workspaces mount, then answer structural questions "
        "(callers, callees, call paths, dependencies, symbol search) with a "
        "single graph query instead of grep/read chains."
    ),
)


def _conn():
    return db.connect(_CONFIG.db_path)


def _normalize_rel(path: str) -> str:
    return path.strip().lstrip("/\\").replace("\\", "/") or "."


@mcp.tool()
def index_repository(name: str, path: str) -> dict[str, Any]:
    """Fully index a repository into the graph (replacing any prior index).

    Args:
        name: identifier to store the repo under (letters, digits, . _ -).
        path: repo location relative to the /workspaces mount, e.g. "my-service".
    """
    if not _NAME_RE.match(name or ""):
        return {"error": "invalid repo name; use letters, digits, '.', '_', '-'"}
    rel = _normalize_rel(path)
    try:
        abs_root = safe_join(_CONFIG.workspaces_root, rel)
    except ValueError as exc:
        return {"error": str(exc)}
    if not abs_root.is_dir():
        return {"error": f"not a directory under /workspaces: {rel!r}"}
    result = _INDEXER.index_full(name, abs_root, rel)
    return _result_dict(result)


@mcp.tool()
def reindex_repository(name: str) -> dict[str, Any]:
    """Incrementally re-index a repo: only files whose content hash changed are
    re-parsed, deleted files are dropped, then call edges are re-resolved.

    Args:
        name: the repo name previously passed to index_repository.
    """
    con = _conn()
    try:
        row = con.execute("SELECT path FROM repos WHERE name = ?", (name,)).fetchone()
    finally:
        con.close()
    if row is None:
        return {"error": f"repo {name!r} is not indexed; call index_repository first"}
    rel = row["path"]
    try:
        abs_root = safe_join(_CONFIG.workspaces_root, rel)
    except ValueError as exc:
        return {"error": str(exc)}
    if not abs_root.is_dir():
        return {"error": f"repo directory no longer present under /workspaces: {rel!r}"}
    result = _INDEXER.reindex(name, abs_root, rel)
    return _result_dict(result)


@mcp.tool()
def list_repositories() -> list[dict[str, Any]]:
    """List indexed repositories with their node, edge and file counts."""
    con = _conn()
    try:
        return queries.list_repositories(con)
    finally:
        con.close()


@mcp.tool()
def search_symbol(
    pattern: str, repo: Optional[str] = None, limit: int = 100
) -> list[dict[str, Any]]:
    """Find functions, methods, classes or interfaces by name pattern.

    Args:
        pattern: substring, or a glob with '*' / '?' wildcards.
        repo: optional repo name to scope the search.
        limit: maximum results (default 100).
    """
    con = _conn()
    try:
        return queries.search_symbol(con, pattern, repo, max(1, min(int(limit), 1000)))
    finally:
        con.close()


@mcp.tool()
def get_callers(qualified_name: str, repo: Optional[str] = None) -> list[dict[str, Any]]:
    """Return the functions/methods that call `qualified_name`.

    Args:
        qualified_name: fully-qualified name, e.g. "pkg.mod.Class.method".
        repo: optional repo name to disambiguate across repos.
    """
    con = _conn()
    try:
        return queries.get_callers(con, qualified_name, repo)
    finally:
        con.close()


@mcp.tool()
def get_callees(qualified_name: str, repo: Optional[str] = None) -> list[dict[str, Any]]:
    """Return what `qualified_name` calls (resolved targets and honest unresolved).

    Args:
        qualified_name: fully-qualified name of the caller.
        repo: optional repo name to disambiguate across repos.
    """
    con = _conn()
    try:
        return queries.get_callees(con, qualified_name, repo)
    finally:
        con.close()


@mcp.tool()
def trace_call_path(
    qualified_name: str,
    direction: str = "callees",
    depth: int = 3,
    repo: Optional[str] = None,
) -> dict[str, Any]:
    """Breadth-first traversal of the call graph, depth-limited.

    Args:
        qualified_name: starting symbol.
        direction: "callees" (what it calls, downstream) or "callers" (upstream).
        depth: maximum levels to traverse (1-20, default 3).
        repo: optional repo name to scope the traversal.
    """
    con = _conn()
    try:
        return queries.trace_call_path(con, qualified_name, direction, depth, repo)
    except ValueError as exc:
        return {"error": str(exc)}
    finally:
        con.close()


@mcp.tool()
def get_dependencies(file_path: str, repo: Optional[str] = None) -> list[dict[str, Any]]:
    """Return the imports of a file (repo-relative path), flagged in-project or not.

    Args:
        file_path: repo-relative path, e.g. "pkg/module.py".
        repo: optional repo name to disambiguate if the path exists in several.
    """
    con = _conn()
    try:
        return queries.get_dependencies(con, file_path, repo)
    finally:
        con.close()


@mcp.tool()
def get_code_snippet(qualified_name: str, repo: Optional[str] = None) -> dict[str, Any]:
    """Return the source text of a symbol, read fresh from disk (never stored).

    Args:
        qualified_name: fully-qualified name of the symbol.
        repo: optional repo name to disambiguate across repos.
    """
    con = _conn()
    try:
        return queries.get_code_snippet(con, _CONFIG, qualified_name, repo)
    finally:
        con.close()


# --- Visualizer HTTP routes ------------------------------------------------
# Mounted on the same Starlette app as the MCP endpoint, so the graph UI at `/`
# and the preview API at `/api/*` share this service's loopback-only binding
# and its `safe_join` confinement. See web.py for the same-origin rationale.
for _spec in web.route_specs(_CONFIG, _conn):
    mcp.custom_route(_spec.path, methods=_spec.methods, name=_spec.name)(
        _spec.endpoint
    )


def _result_dict(result) -> dict[str, Any]:
    return {
        "repo": result.repo,
        "status": result.status,
        "files_indexed": result.files_indexed,
        "files_skipped": result.files_skipped,
        "files_deleted": result.files_deleted,
        "nodes": result.nodes,
        "edges": result.edges,
    }


def main() -> None:
    # Touch the DB so the schema exists before the first tool call.
    _conn().close()
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
