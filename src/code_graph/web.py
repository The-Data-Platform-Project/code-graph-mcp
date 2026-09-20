"""HTTP routes backing the visualizer: the graph payload and source previews.

These ride on the same Starlette app as the MCP endpoint (see `server.py`), so
they inherit its binding: the container listens on 0.0.0.0:8765 but compose
publishes that only to the host's 127.0.0.1. The visualizer is served from `/`
on this same origin, which is deliberate — a same-origin page needs no CORS
headers, so no other site the browser visits can read these responses.

Like the MCP tools, every path here is confined to the read-only workspaces
mount by `safe_join`, and source text is read fresh from disk rather than
stored in the graph.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Callable, NamedTuple, Optional

from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response

from . import graph_export, queries
from .config import Config


def _json(payload: Any, status: int = 200) -> JSONResponse:
    # The visualizer always refetches; a stale preview of an edited file would
    # be worse than the extra round trip.
    return JSONResponse(
        payload, status_code=status, headers={"Cache-Control": "no-store"}
    )


def _error(message: str, status: int = 400) -> JSONResponse:
    return _json({"found": False, "error": message}, status=status)


def _param(request: Request, name: str) -> str:
    return (request.query_params.get(name) or "").strip()


class RouteSpec(NamedTuple):
    """A route described declaratively, so both the FastMCP app and the test
    app can mount the same handlers without either importing the other."""

    path: str
    methods: list[str]
    name: str
    endpoint: Callable[[Request], Any]


def route_specs(
    config: Config, connect: Callable[[], sqlite3.Connection]
) -> list[RouteSpec]:
    """Build the visualizer routes against a config and a connection factory.

    Taking the factory as an argument keeps this module free of module-level
    state, so the routes can be mounted on a bare Starlette app in tests.
    """

    def _with_conn(fn: Callable[[sqlite3.Connection], Any]) -> Any:
        con = connect()
        try:
            return fn(con)
        finally:
            con.close()

    async def graph(request: Request) -> Response:
        payload = await run_in_threadpool(
            lambda: _with_conn(graph_export.build_payload)
        )
        return _json(payload)

    async def readme(request: Request) -> Response:
        repo = _param(request, "repo")
        if not repo:
            return _error("missing 'repo' parameter")
        result = await run_in_threadpool(
            lambda: _with_conn(lambda con: queries.get_repo_readme(con, config, repo))
        )
        return _json(result, status=200 if result.get("found") else 404)

    async def node(request: Request) -> Response:
        qname = _param(request, "qname")
        if not qname:
            return _error("missing 'qname' parameter")
        repo: Optional[str] = _param(request, "repo") or None
        result = await run_in_threadpool(
            lambda: _with_conn(
                lambda con: queries.get_node_context(con, config, qname, repo)
            )
        )
        return _json(result, status=200 if result.get("found") else 404)

    async def file(request: Request) -> Response:
        repo = _param(request, "repo")
        path = _param(request, "path")
        if not repo or not path:
            return _error("both 'repo' and 'path' parameters are required")
        result = await run_in_threadpool(
            lambda: _with_conn(
                lambda con: queries.get_file_source(con, config, repo, path)
            )
        )
        return _json(result, status=200 if result.get("found") else 404)

    async def index(request: Request) -> Response:
        page = Path(config.visualizer_dir) / "index.html"
        if not page.is_file():
            return _json(
                {
                    "error": "visualizer/index.html not found",
                    "looked_in": str(config.visualizer_dir),
                    "hint": "set VISUALIZER_DIR to the directory holding index.html",
                },
                status=404,
            )
        return FileResponse(page, headers={"Cache-Control": "no-store"})

    return [
        RouteSpec("/", ["GET"], "visualizer", index),
        RouteSpec("/api/graph", ["GET"], "api_graph", graph),
        RouteSpec("/api/readme", ["GET"], "api_readme", readme),
        RouteSpec("/api/node", ["GET"], "api_node", node),
        RouteSpec("/api/file", ["GET"], "api_file", file),
    ]
