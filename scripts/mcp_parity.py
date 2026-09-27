#!/usr/bin/env python3
"""Check that two MCP endpoints serving the same graph give the same answers.

    PARITY_TOKEN_A=... PARITY_TOKEN_B=... python scripts/mcp_parity.py \\
        http://127.0.0.1:8765/mcp https://<app>.vercel.app/api/mcp

Meant for the Python server (A) against the Next.js endpoint (B), both reading
the same tenant graph: the TypeScript tools are a port, and this is what keeps
the port honest before MCP_BACKEND is switched either way. Tokens come from
the environment (or a prompt), never the command line.

It calls every read tool on a deterministic sample of symbols and files drawn
from A, and compares structuredContent, isError and the number of content
items. get_code_snippet is compared only where both sides found the source,
since A reads a disk and B reads GitHub; a snippet whose node matches but whose
text does not is reported as source drift (the graph's commit and the source
differ), not as a port difference.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

READ_TOOLS = {
    "list_repositories", "search_symbol", "get_callers", "get_callees",
    "trace_call_path", "get_dependencies", "get_code_snippet",
}


def _token(var: str, label: str) -> str:
    return os.environ.get(var) or getpass.getpass(f"  bearer token for {label}: ")


def _sample(items: list, n: int) -> list:
    if len(items) <= n:
        return items
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


class Endpoint:
    def __init__(self, url: str, token: str):
        self.url, self.token = url, token

    async def __aenter__(self):
        self._http = streamablehttp_client(
            self.url, headers={"Authorization": f"Bearer {self.token}"}
        )
        read, write, _ = await self._http.__aenter__()
        self._session = ClientSession(read, write)
        self.session = await self._session.__aenter__()
        await self.session.initialize()
        return self

    async def __aexit__(self, *exc):
        await self._session.__aexit__(*exc)
        await self._http.__aexit__(*exc)

    async def call(self, name: str, args: dict) -> dict:
        res = await self.session.call_tool(name, args)
        return {
            "isError": bool(res.isError),
            "items": len(res.content),
            "structured": res.structuredContent,
            "text": res.content[0].text if res.content else None,
        }


async def build_cases(a: Endpoint, samples: int) -> list[tuple[str, dict]]:
    cases: list[tuple[str, dict]] = [("list_repositories", {})]
    for pattern in ("*", "get", "GET_*", "Index?r", "no_such_symbol_xyz", "%", "_"):
        cases.append(("search_symbol", {"pattern": pattern, "limit": 50}))
    symbols = (await a.call("search_symbol", {"pattern": "*", "limit": 1000}))["structured"]
    symbols = symbols["result"] if symbols else []
    repos = sorted({s["repo"] for s in symbols})
    if repos:
        cases.append(("search_symbol", {"pattern": "*", "repo": repos[0], "limit": 7}))

    for s in _sample([s for s in symbols if s["kind"] != "Config"], samples):
        q = s["qualified_name"]
        cases += [
            ("get_callers", {"qualified_name": q}),
            ("get_callees", {"qualified_name": q, "repo": s["repo"]}),
            ("trace_call_path", {"qualified_name": q, "direction": "callees", "depth": 3}),
            ("trace_call_path", {"qualified_name": q, "direction": "callers", "depth": 2}),
            ("get_code_snippet", {"qualified_name": q}),
        ]
    for path in _sample(sorted({s["file_path"] for s in symbols}), samples):
        cases.append(("get_dependencies", {"file_path": path}))

    cases += [
        ("get_callers", {"qualified_name": "no.such.symbol"}),
        ("trace_call_path", {"qualified_name": "x", "direction": "sideways"}),
        ("trace_call_path", {"qualified_name": "x", "depth": 99}),
        ("get_code_snippet", {"qualified_name": "no.such.symbol"}),
        ("get_dependencies", {"file_path": "no/such/file.py"}),
    ]
    return cases


def _differs(name: str, ra: dict, rb: dict) -> str | None:
    if name == "get_code_snippet":
        sa, sb = ra["structured"] or {}, rb["structured"] or {}
        if not (sa.get("found") and sb.get("found")):
            return None  # one side could not reach the source; not a graph difference
        if {**sa, "code": None} == {**sb, "code": None} and sa["code"] != sb["code"]:
            # Same node, same lines, different text: the two sides read different
            # versions of the file, i.e. the graph's commit and the source differ.
            return "drift"
    for key in ("isError", "items", "structured"):
        if ra[key] != rb[key]:
            return key
    return None


async def run(url_a: str, url_b: str, samples: int, verbose: bool) -> int:
    async with Endpoint(url_a, _token("PARITY_TOKEN_A", url_a)) as a, \
            Endpoint(url_b, _token("PARITY_TOKEN_B", url_b)) as b:
        tools_a = {t.name for t in (await a.session.list_tools()).tools} & READ_TOOLS
        tools_b = {t.name for t in (await b.session.list_tools()).tools} & READ_TOOLS
        failures = 0
        if tools_a != tools_b:
            print(f"  tool sets differ: only A {sorted(tools_a - tools_b)}, "
                  f"only B {sorted(tools_b - tools_a)}")
            failures += 1

        cases = await build_cases(a, samples)
        skipped = 0
        drift: list[str] = []
        for name, args in cases:
            ra, rb = await a.call(name, args), await b.call(name, args)
            if name == "get_code_snippet" and not (
                (ra["structured"] or {}).get("found") and (rb["structured"] or {}).get("found")
            ):
                skipped += 1
            key = _differs(name, ra, rb)
            if key == "drift":
                drift.append(args["qualified_name"])
            elif key:
                failures += 1
                print(f"  DIFF {name} {json.dumps(args)}: {key}")
                if verbose:
                    print(f"    A: {json.dumps(ra[key], default=str)[:600]}")
                    print(f"    B: {json.dumps(rb[key], default=str)[:600]}")
        if drift:
            print(f"\n  source drift in {len(drift)} snippet(s), e.g. {drift[0]}: same node and\n"
                  "  lines, different text — the sides read different versions of the file.\n"
                  "  Pin the repo connection's git_ref to the commit the graph was built from.")
        print(f"\n  {len(cases)} calls, {failures} difference(s)"
              f"{f', {skipped} snippet(s) not comparable (source unavailable on a side)' if skipped else ''}")
        return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("url_a", help="reference endpoint, e.g. the Python server's /mcp")
    ap.add_argument("url_b", help="endpoint under test, e.g. the app's /api/mcp")
    ap.add_argument("--samples", type=int, default=40, help="symbols and files to sample")
    ap.add_argument("-v", "--verbose", action="store_true", help="print differing values")
    args = ap.parse_args()
    return asyncio.run(run(args.url_a, args.url_b, args.samples, args.verbose))


if __name__ == "__main__":
    sys.exit(main())
