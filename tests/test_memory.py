"""Memory ceiling test: index a real, large repo and assert peak RSS stays low.

Uses the Python standard library (always present, offline, ~1500+ files) as the
subject. Skipped on platforms without `resource` (e.g. Windows); the meaningful
measurement happens in the Linux container, but this also runs in CI on Linux.
"""

from __future__ import annotations

import sys
import sysconfig
from pathlib import Path

import pytest

from code_graph.config import Config
from code_graph.indexer import Indexer

resource = pytest.importorskip("resource")

CEILING_MB = 450.0
MIN_FILES = 300


def _peak_rss_mb() -> float:
    ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return ru / divisor


def test_indexing_stdlib_stays_under_ceiling(tmp_path):
    stdlib = Path(sysconfig.get_path("stdlib"))
    py_files = sum(1 for _ in stdlib.rglob("*.py"))
    if py_files < MIN_FILES:
        pytest.skip(f"stdlib has too few files to be a meaningful test ({py_files})")

    config = Config(
        db_path=tmp_path / "mem.db",
        workspaces_root=stdlib.parent,
        host="127.0.0.1",
        port=8765,
        max_file_bytes=1_500_000,
        commit_batch_files=200,
    )
    result = Indexer(config).index_full("stdlib", stdlib, stdlib.name)

    assert result.files_indexed >= MIN_FILES
    assert result.nodes > 0 and result.edges > 0

    peak = _peak_rss_mb()
    assert peak < CEILING_MB, (
        f"peak RSS {peak:.1f} MB exceeded ceiling {CEILING_MB:.0f} MB while "
        f"indexing {result.files_indexed} files"
    )
