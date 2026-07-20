"""Shared fixtures: a small but representative sample repo, indexed into a temp DB.

The sample deliberately exercises every resolution branch:
- import-map resolution (`from .utils import helper`)
- same-module resolution (`Widget(...)` called inside its own module)
- unique-name resolution of an inherited method (`self.greet()`)
- honest unresolved (a call to an external/undefined name)
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from code_graph import db  # noqa: E402
from code_graph.config import Config  # noqa: E402
from code_graph.indexer import Indexer  # noqa: E402

_UTILS = '''\
import json


def helper(x):
    return x + 1


class Base:
    def greet(self):
        return "hi"
'''

_CORE = '''\
from .utils import helper, Base


class Widget(Base):
    def __init__(self, n: int):
        self.n = n

    def run(self):
        return helper(self.n)

    def greet_twice(self):
        return self.greet() + self.greet()


def build(n):
    w = Widget(n)
    return w.run()
'''

_APP = '''\
from pkg.core import build, Widget


def main():
    return build(5)


def make():
    return Widget(1)


def orphan():
    return does_not_exist(1)
'''


def _write_sample(root: Path) -> None:
    pkg = root / "pkg"
    pkg.mkdir(parents=True, exist_ok=True)
    (pkg / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "utils.py").write_text(_UTILS, encoding="utf-8")
    (pkg / "core.py").write_text(_CORE, encoding="utf-8")
    (root / "app.py").write_text(_APP, encoding="utf-8")


@pytest.fixture
def sample_root(tmp_path: Path) -> Path:
    root = tmp_path / "workspaces" / "sample"
    _write_sample(root)
    return root


@pytest.fixture
def config(tmp_path: Path, sample_root: Path) -> Config:
    return Config(
        db_path=tmp_path / "graph.db",
        workspaces_root=sample_root.parent,  # /workspaces contains "sample"
        host="127.0.0.1",
        port=8765,
        max_file_bytes=1_500_000,
        commit_batch_files=200,
    )


@pytest.fixture
def indexed(config: Config, sample_root: Path) -> Config:
    Indexer(config).index_full("sample", sample_root, "sample")
    return config


@pytest.fixture
def conn(indexed: Config):
    con = db.connect(indexed.db_path)
    yield con
    con.close()


@pytest.fixture
def make_repo(tmp_path: Path):
    """Factory: write a {rel_path: content} repo, index it, return (conn, config).

    Used by the multi-language extractor tests to build small, focused samples
    without repeating the temp-dir/index boilerplate. Connections are closed at
    teardown.
    """
    conns = []

    def _make(files: dict, name: str = "repo"):
        root = tmp_path / "ws"
        repo = root / name
        for rel, content in files.items():
            p = repo / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
        cfg = Config(
            db_path=tmp_path / "graph.db",
            workspaces_root=root,
            host="127.0.0.1",
            port=8765,
            max_file_bytes=1_500_000,
            commit_batch_files=200,
        )
        Indexer(cfg).index_full(name, repo, name)
        con = db.connect(cfg.db_path)
        conns.append(con)
        return con, cfg

    yield _make
    for con in conns:
        con.close()
