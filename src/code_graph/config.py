"""Runtime configuration, read once from the environment.

Every value has a safe default so the package is runnable outside Docker (for
tests and the memory-check script). The container overrides these via the
`environment:` block in docker-compose.yml.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    # Where the SQLite graph lives. On the container this is /data/graph.db,
    # which is a host bind mount so the graph survives rebuilds.
    db_path: Path
    # Parent directory holding every indexable repo. Mounted read-only on the
    # container as /workspaces. `index_repository` paths are relative to this.
    workspaces_root: Path
    # MCP HTTP bind address. Defaults to loopback for bare runs; the container
    # sets 0.0.0.0 so Docker's published 127.0.0.1:8765 mapping can reach it.
    host: str
    port: int
    # Files larger than this are skipped during indexing. Guards against a
    # single generated/minified file blowing the memory budget.
    max_file_bytes: int
    # How many files to parse before flushing a batch to SQLite. Bounds peak
    # memory: parse trees are discarded per file, and pending rows per batch.
    commit_batch_files: int
    # Directory holding the visualizer's index.html, served from `/` on the
    # same origin as the API so previews need no CORS relaxation. Defaults to
    # the checkout's ./visualizer; the image sets it to /app/visualizer.
    visualizer_dir: Path = Path("./visualizer")

    @staticmethod
    def from_env() -> "Config":
        return Config(
            db_path=Path(os.environ.get("GRAPH_DB_PATH", "./data/graph.db")),
            workspaces_root=Path(os.environ.get("WORKSPACES_ROOT", "./workspaces")),
            host=os.environ.get("MCP_HOST", "127.0.0.1"),
            port=_int_env("MCP_PORT", 8765),
            max_file_bytes=_int_env("MAX_FILE_BYTES", 1_500_000),
            commit_batch_files=_int_env("COMMIT_BATCH_FILES", 200),
            visualizer_dir=Path(os.environ.get("VISUALIZER_DIR", "./visualizer")),
        )
