#!/usr/bin/env python3
"""End-to-end MCP smoke test against the running streamable-HTTP server.

Connects like Claude Code would, lists tools, indexes real repos under
/workspaces, and runs graph queries to prove the graph is genuinely usable.
"""

from __future__ import annotations

import asyncio
import json
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = "http://127.0.0.1:8765/mcp"


def _payload(result):
    if getattr(result, "structuredContent", None):
        sc = result.structuredContent
        return sc.get("result", sc)
    out = []
    for block in result.content:
        out.append(getattr(block, "text", str(block)))
    return "\n".join(out)


async def call(session, tool, **args):
    res = await session.call_tool(tool, args)
    return _payload(res)


async def main() -> int:
    async with streamablehttp_client(URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            names = sorted(t.name for t in tools.tools)
            print("TOOLS:", names)

            print("\n== index data-platform ==")
            print(json.dumps(await call(
                session, "index_repository",
                name="data-platform", path="DataPlatform/data-platform"), indent=2))

            print("\n== list_repositories ==")
            print(json.dumps(await call(session, "list_repositories"), indent=2))

            print("\n== search_symbol 'main' (data-platform) ==")
            hits = await call(session, "search_symbol", pattern="*", repo="data-platform", limit=8)
            print(json.dumps(hits, indent=2))

            # Pick a real function that has callers, to prove the call graph works.
            print("\n== find a symbol with callers ==")
            picked = await find_symbol_with_callers(session, "data-platform")
            print("picked:", picked)
            if picked:
                print("\n== get_callers ==")
                print(json.dumps(await call(session, "get_callers", qualified_name=picked), indent=2))
                print("\n== get_callees ==")
                print(json.dumps(await call(session, "get_callees", qualified_name=picked), indent=2))
                print("\n== trace_call_path (callers, depth 3) ==")
                print(json.dumps(await call(
                    session, "trace_call_path",
                    qualified_name=picked, direction="callers", depth=3), indent=2))
                print("\n== get_code_snippet ==")
                snip = await call(session, "get_code_snippet", qualified_name=picked)
                if isinstance(snip, dict):
                    snip["code"] = "\n".join(snip.get("code", "").splitlines()[:6]) + "\n..."
                print(json.dumps(snip, indent=2))

            print("\n== index SECOND repo (no rebuild): tapmad-reconciliation ==")
            print(json.dumps(await call(
                session, "index_repository",
                name="tapmad-reconciliation", path="Tapmad/tapmad-reconciliation"), indent=2))

            print("\n== list_repositories (both) ==")
            print(json.dumps(await call(session, "list_repositories"), indent=2))
    return 0


async def find_symbol_with_callers(session, repo):
    """Scan resolved functions until we find one that is actually called."""
    hits = await call(session, "search_symbol", pattern="*", repo=repo, limit=400)
    if not isinstance(hits, list):
        return None
    for h in hits:
        qn = h.get("qualified_name")
        if not qn or h.get("kind") not in ("Function", "Method"):
            continue
        callers = await call(session, "get_callers", qualified_name=qn)
        if isinstance(callers, list) and callers:
            return qn
    return None


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
