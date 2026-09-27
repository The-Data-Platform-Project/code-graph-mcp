"""Shared fixtures: a small but representative sample repo, indexed into Postgres.

Every test gets its own Postgres *schema*, created and dropped around it, so
tests are isolated without the cost of a database per test. Point
TEST_DATABASE_URL at any reachable Postgres; docker-compose's `postgres`
service works, as does a local install.

The sample deliberately exercises every resolution branch:
- import-map resolution (`from .utils import helper`)
- same-module resolution (`Widget(...)` called inside its own module)
- unique-name resolution of an inherited method (`self.greet()`)
- honest unresolved (a call to an external/undefined name)
"""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path
from urllib.parse import quote

import psycopg
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from code_graph import db  # noqa: E402
from code_graph.config import Config  # noqa: E402
from code_graph.indexer import Indexer  # noqa: E402

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/postgres"
)


def _dsn_for_schema(schema: str) -> str:
    """Same database, but every statement resolves inside `schema`."""
    sep = "&" if "?" in TEST_DATABASE_URL else "?"
    return f"{TEST_DATABASE_URL}{sep}options={quote(f'-csearch_path={schema}')}"


@pytest.fixture
def database_url():
    """An empty, isolated schema for one test, dropped afterwards."""
    schema = f"t_{uuid.uuid4().hex[:12]}"
    try:
        admin = psycopg.connect(TEST_DATABASE_URL, autocommit=True)
    except psycopg.OperationalError as exc:  # pragma: no cover - env problem
        pytest.skip(f"no Postgres at TEST_DATABASE_URL: {exc}")
    try:
        admin.execute(f'CREATE SCHEMA "{schema}"')
        yield _dsn_for_schema(schema)
    finally:
        admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
        admin.close()

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
def config(database_url: str, sample_root: Path) -> Config:
    return Config(
        database_url=database_url,
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
    con = db.connect(indexed.database_url)
    yield con
    con.close()


@pytest.fixture
def make_repo(tmp_path: Path, database_url: str):
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
            database_url=database_url,
            workspaces_root=root,
            host="127.0.0.1",
            port=8765,
            max_file_bytes=1_500_000,
            commit_batch_files=200,
        )
        Indexer(cfg).index_full(name, repo, name)
        con = db.connect(cfg.database_url)
        conns.append(con)
        return con, cfg

    yield _make
    for con in conns:
        con.close()
