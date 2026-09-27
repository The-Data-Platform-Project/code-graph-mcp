"""HTTP routes backing the visualizer, plus the token gate on the whole service.

The routes ride on the same Starlette app as the MCP endpoint (see
`server.py`). Historically that app was only reachable on loopback; it is now
also published through an ngrok tunnel so the Vercel-hosted app can reach it,
which changes the threat model completely: `/api/file` serves files from the
workspaces mount, so an open tunnel would publish the indexed repositories to
anyone who guesses the URL.

`TokenAuthMiddleware` therefore gates *everything* except `/healthz` on a
shared secret, `/mcp` included — it wraps the finished ASGI app rather than
being a route concern, because the MCP transport is mounted, not routed.

Like the MCP tools, every path here is confined to the read-only workspaces
mount by `safe_join`, and source text is read fresh from disk rather than
stored in the graph.
"""

from __future__ import annotations

import hmac
import logging
from pathlib import Path
from typing import Any, Callable, NamedTuple, Optional

import psycopg

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


_log = logging.getLogger("code_graph.web")

# Reachable without a token: the container healthcheck and the tunnel's own
# probes need somewhere to knock that reveals nothing.
PUBLIC_PATHS = frozenset({"/healthz"})


class TokenAuthMiddleware:
    """Require a shared secret on every request except `PUBLIC_PATHS`.

    Plain ASGI rather than Starlette's BaseHTTPMiddleware so it can wrap the
    app *after* FastMCP has built it, and so lifespan messages pass straight
    through to the MCP session manager untouched.

    The token is accepted as `Authorization: Bearer <token>` or
    `X-Code-Graph-Token: <token>`, never as a query parameter — query strings
    end up in proxy and tunnel logs.
    """

    def __init__(self, app, token: str) -> None:
        self._app = app
        self._token = token or ""
        if not self._token:
            _log.warning(
                "CODE_GRAPH_TOKEN is not set: /mcp and /api/* are UNAUTHENTICATED. "
                "This is only safe while the service is reachable on loopback "
                "alone — never expose it through a tunnel in this state."
            )

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or not self._token:
            await self._app(scope, receive, send)
            return
        if scope.get("path") in PUBLIC_PATHS or self._authorized(scope):
            await self._app(scope, receive, send)
            return
        await _unauthorized(send)

    def _authorized(self, scope) -> bool:
        presented = ""
        for raw_name, raw_value in scope.get("headers", []):
            name = raw_name.decode("latin-1").lower()
            if name == "authorization":
                value = raw_value.decode("latin-1")
                presented = value[7:] if value[:7].lower() == "bearer " else ""
                break
            if name == "x-code-graph-token":
                presented = raw_value.decode("latin-1")
                break
        # Constant time: the comparison must not leak the token's prefix.
        return hmac.compare_digest(presented.strip(), self._token)


async def _unauthorized(send) -> None:
    body = b'{"error":"missing or invalid token"}'
    await send(
        {
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"www-authenticate", b"Bearer"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class RouteSpec(NamedTuple):
    """A route described declaratively, so both the FastMCP app and the test
    app can mount the same handlers without either importing the other."""

    path: str
    methods: list[str]
    name: str
    endpoint: Callable[[Request], Any]


def route_specs(
    config: Config, connect: Callable[[], psycopg.Connection]
) -> list[RouteSpec]:
    """Build the visualizer routes against a config and a connection factory.

    Taking the factory as an argument keeps this module free of module-level
    state, so the routes can be mounted on a bare Starlette app in tests.
    """

    def _with_conn(fn: Callable[[psycopg.Connection], Any]) -> Any:
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

    async def healthz(request: Request) -> Response:
        # Deliberately says nothing about the graph or the repos: it is the one
        # route reachable without a token.
        return _json({"status": "ok"})

    return [
        RouteSpec("/healthz", ["GET"], "healthz", healthz),
        RouteSpec("/", ["GET"], "visualizer", index),
        RouteSpec("/api/graph", ["GET"], "api_graph", graph),
        RouteSpec("/api/readme", ["GET"], "api_readme", readme),
        RouteSpec("/api/node", ["GET"], "api_node", node),
        RouteSpec("/api/file", ["GET"], "api_file", file),
    ]
