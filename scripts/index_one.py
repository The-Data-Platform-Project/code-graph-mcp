#!/usr/bin/env python3
"""Index a single repo via the live MCP endpoint. Usage: index_one.py NAME PATH."""

from __future__ import annotations

import asyncio
import json
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

URL = "http://127.0.0.1:8765/mcp"


async def main(name: str, path: str) -> int:
    async with streamablehttp_client(URL) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            res = await session.call_tool("index_repository", {"name": name, "path": path})
            sc = getattr(res, "structuredContent", None)
            print(json.dumps(sc.get("result", sc) if sc else
                             [getattr(b, "text", str(b)) for b in res.content], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2])))
