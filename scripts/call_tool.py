#!/usr/bin/env python3
"""Call one MCP tool and print its result.

Usage: call_tool.py TOOL [key=value ...]
  e.g. call_tool.py get_callers qualified_name=pkg.mod.func
       call_tool.py trace_call_path qualified_name=pkg.mod.f direction=callers depth=3

Sends CODE_GRAPH_TOKEN from the environment as a bearer token; CODE_GRAPH_URL
overrides the endpoint.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = os.environ.get("CODE_GRAPH_URL", "http://127.0.0.1:8765/mcp")
_INT_KEYS = {"depth", "limit"}


def _parse_args(pairs: list[str]) -> dict:
    args: dict = {}
    for pair in pairs:
        key, _, value = pair.partition("=")
        args[key] = int(value) if key in _INT_KEYS else value
    return args


async def main(tool: str, args: dict) -> int:
    token = os.environ.get("CODE_GRAPH_TOKEN", "")
    headers = {"Authorization": f"Bearer {token}"} if token else None
    async with streamablehttp_client(URL, headers=headers) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            res = await session.call_tool(tool, args)
            sc = getattr(res, "structuredContent", None)
            payload = sc.get("result", sc) if sc else [
                getattr(b, "text", str(b)) for b in res.content
            ]
            print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    tool_name = sys.argv[1]
    args = _parse_args(sys.argv[2:])
    sys.exit(asyncio.run(main(tool_name, args)))
