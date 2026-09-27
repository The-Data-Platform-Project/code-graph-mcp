#!/usr/bin/env python3
"""Index a real repo and report peak RSS, to prove the memory budget holds.

Runs the actual indexing pipeline against a large, offline repo (defaults to the
Python standard library that ships in the image) and measures peak resident set
size via `resource.getrusage`. Exits non-zero if peak RSS exceeds the ceiling,
so it doubles as a CI/acceptance gate.

Usage (inside the container):
    python scripts/memory_check.py
    python scripts/memory_check.py --path /workspaces/DataPlatform/data-platform
    python scripts/memory_check.py --path <dir> --ceiling-mb 450
"""

from __future__ import annotations

import argparse
import resource
import os
import sys
import sysconfig
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from code_graph.config import Config  # noqa: E402
from code_graph.indexer import Indexer  # noqa: E402


def peak_rss_mb() -> float:
    # ru_maxrss is kilobytes on Linux, bytes on macOS.
    ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return ru / divisor


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--path",
        default=sysconfig.get_path("stdlib"),
        help="repo directory to index (default: Python stdlib)",
    )
    parser.add_argument("--name", default="memcheck")
    parser.add_argument("--ceiling-mb", type=float, default=450.0)
    args = parser.parse_args()

    root = Path(args.path).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2

    # No temp directory any more: the graph lives in Postgres, so this writes
    # into whatever DATABASE_URL points at. Use a scratch database.
    config = Config(
        database_url=os.environ.get(
            "DATABASE_URL",
            "postgresql://codegraph:codegraph@127.0.0.1:5432/codegraph",
        ),
        workspaces_root=root.parent,
        host="127.0.0.1",
        port=8765,
        max_file_bytes=1_500_000,
        commit_batch_files=200,
    )
    indexer = Indexer(config)
    print(f"Indexing {root} ...")
    start = time.perf_counter()
    result = indexer.index_full(args.name, root, root.name)
    elapsed = time.perf_counter() - start

    peak = peak_rss_mb()
    print(f"  files indexed : {result.files_indexed}")
    print(f"  files skipped : {result.files_skipped}")
    print(f"  nodes         : {result.nodes}")
    print(f"  edges         : {result.edges}")
    print(f"  elapsed       : {elapsed:.1f}s")
    print(f"  peak RSS      : {peak:.1f} MB (ceiling {args.ceiling_mb:.0f} MB)")

    if peak > args.ceiling_mb:
        print("FAIL: peak RSS exceeded ceiling", file=sys.stderr)
        return 1
    print("OK: within memory budget")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
