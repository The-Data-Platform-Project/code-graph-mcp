"""Loading a SQLite graph into a tenant schema, and the control plane it creates.

Each test runs in its own throwaway *database*, not just a schema: the loader
creates schemas of its own (`control`, `tenant_*`), which must not collide
between tests.
"""

from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from psycopg.rows import dict_row

from code_graph import control, sqlite_import
from code_graph.sqlite_import import GRAPH_TABLES, LoadError

from conftest import TEST_DATABASE_URL


@pytest.fixture
def fresh_db():
    """A brand-new database, dropped afterwards. Yields a connection to it."""
    name = f"load_{uuid.uuid4().hex[:10]}"
    try:
        admin = psycopg.connect(TEST_DATABASE_URL, autocommit=True)
    except psycopg.OperationalError as exc:  # pragma: no cover - env problem
        pytest.skip(f"no Postgres at TEST_DATABASE_URL: {exc}")
    admin.execute(f'CREATE DATABASE "{name}"')
    parts = urlsplit(TEST_DATABASE_URL)
    dsn = urlunsplit(parts._replace(path=f"/{name}"))
    con = psycopg.connect(dsn, row_factory=dict_row)
    try:
        yield con
    finally:
        con.close()
        admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        admin.close()


@pytest.fixture
def sqlite_graph(conn, tmp_path) -> Path:
    """The sample repo's graph, written out in the SQLite format `main` produces."""
    path = tmp_path / "graph.db"
    lite = sqlite3.connect(path)
    lite.executescript(
        """
        CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, indexed_at TEXT,
            node_count INTEGER NOT NULL DEFAULT 0, edge_count INTEGER NOT NULL DEFAULT 0,
            file_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE nodes (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, kind TEXT NOT NULL,
            name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL,
            start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT);
        CREATE TABLE edges (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, edge_type TEXT NOT NULL,
            src_qname TEXT NOT NULL, dst_qname TEXT NOT NULL, dst_raw TEXT NOT NULL,
            src_file TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE files (repo TEXT NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL,
            PRIMARY KEY (repo, path));
        CREATE TABLE imports (repo TEXT NOT NULL, file_path TEXT NOT NULL,
            local_name TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
            PRIMARY KEY (repo, file_path, local_name));
        """
    )
    for table, cols in GRAPH_TABLES.items():
        rows = conn.execute(f"SELECT {', '.join(cols)} FROM {table}").fetchall()
        lite.executemany(
            f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            [tuple(r[c] for c in cols) for r in rows],
        )
    lite.commit()
    lite.close()
    return path


def _count(con, schema, table):
    return con.execute(f'SELECT COUNT(*) AS n FROM "{schema}".{table}').fetchone()["n"]


def test_load_copies_every_row_into_the_tenant_schema(fresh_db, sqlite_graph, conn):
    loaded = sqlite_import.load(sqlite_graph, fresh_db, "owner", "Owner")
    for table in GRAPH_TABLES:
        source = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
        assert loaded[table] == source
        assert _count(fresh_db, "tenant_owner", table) == source


def test_load_creates_the_control_plane(fresh_db, sqlite_graph):
    sqlite_import.load(sqlite_graph, fresh_db, "owner", "The Owner")
    tenant = fresh_db.execute(
        "SELECT slug, schema_name, display_name, status FROM control.tenants"
    ).fetchone()
    assert tenant == {
        "slug": "owner", "schema_name": "tenant_owner",
        "display_name": "The Owner", "status": "active",
    }
    tables = {
        r["table_name"]
        for r in fresh_db.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'control'"
        ).fetchall()
    }
    assert tables == {"tenants", "mcp_tokens", "repo_connections"}


def test_graph_stays_out_of_public(fresh_db, sqlite_graph):
    sqlite_import.load(sqlite_graph, fresh_db, "owner", "Owner")
    public = fresh_db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_name IN ('repos','nodes','edges')"
    ).fetchone()["n"]
    assert public == 0


def test_sequences_are_fast_forwarded(fresh_db, sqlite_graph):
    sqlite_import.load(sqlite_graph, fresh_db, "owner", "Owner")
    # A fresh insert must not collide with a copied id.
    new_id = fresh_db.execute(
        "INSERT INTO tenant_owner.nodes (repo, kind, name, qualified_name, file_path, "
        "start_line, end_line) VALUES ('x','Function','f','x.f','x.py',1,1) RETURNING id"
    ).fetchone()["id"]
    max_copied = fresh_db.execute(
        "SELECT MAX(id) AS m FROM tenant_owner.nodes WHERE repo <> 'x'"
    ).fetchone()["m"]
    assert new_id > max_copied


def test_github_connections_are_recorded(fresh_db, sqlite_graph):
    sqlite_import.load(
        sqlite_graph, fresh_db, "owner", "Owner",
        connections=[("sample", "acme/sample", "main")],
    )
    row = fresh_db.execute(
        "SELECT repo_name, provider, external_repo, git_ref FROM control.repo_connections"
    ).fetchone()
    assert row == {
        "repo_name": "sample", "provider": "github",
        "external_repo": "acme/sample", "git_ref": "main",
    }


def test_unknown_repo_in_a_connection_is_refused(fresh_db, sqlite_graph):
    with pytest.raises(LoadError, match="not in the graph"):
        sqlite_import.load(
            sqlite_graph, fresh_db, "owner", "Owner",
            connections=[("typo", "acme/sample", None)],
        )


def test_existing_graph_needs_replace(fresh_db, sqlite_graph):
    sqlite_import.load(sqlite_graph, fresh_db, "owner", "Owner")
    with pytest.raises(LoadError, match="--replace"):
        sqlite_import.load(sqlite_graph, fresh_db, "owner", "Owner")
    loaded = sqlite_import.load(sqlite_graph, fresh_db, "owner", "Owner", replace=True)
    # Replaced, not appended.
    assert _count(fresh_db, "tenant_owner", "nodes") == loaded["nodes"]


def test_a_failed_load_commits_nothing(fresh_db, sqlite_graph):
    with pytest.raises(LoadError):
        sqlite_import.load(
            sqlite_graph, fresh_db, "owner", "Owner",
            connections=[("typo", "acme/sample", None)],
        )
    # Not even the control schema: the validation failed before the transaction,
    # and anything inside it would have rolled back.
    exists = fresh_db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.schemata "
        "WHERE schema_name IN ('control', 'tenant_owner')"
    ).fetchone()["n"]
    assert exists == 0


def test_a_mid_transaction_failure_rolls_back(fresh_db, sqlite_graph, monkeypatch):
    # Force the post-load verification to fail, i.e. after COPY has run.
    real = sqlite_import._target_counts
    calls = {"n": 0}

    def flaky(pg, schema):
        calls["n"] += 1
        counts = real(pg, schema)
        return {**counts, "nodes": -1} if calls["n"] == 2 else counts

    monkeypatch.setattr(sqlite_import, "_target_counts", flaky)
    with pytest.raises(LoadError, match="row counts differ"):
        sqlite_import.load(sqlite_graph, fresh_db, "owner", "Owner")
    exists = fresh_db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = 'tenant_owner'"
    ).fetchone()["n"]
    assert exists == 0


def test_empty_sqlite_is_refused(fresh_db, tmp_path):
    empty = tmp_path / "empty.db"
    lite = sqlite3.connect(empty)
    for table, cols in GRAPH_TABLES.items():
        lite.execute(f"CREATE TABLE {table} ({', '.join(cols)})")
    lite.commit()
    lite.close()
    with pytest.raises(LoadError, match="no nodes"):
        sqlite_import.load(empty, fresh_db, "owner", "Owner")


def test_non_graph_sqlite_is_refused(fresh_db, tmp_path):
    other = tmp_path / "other.db"
    sqlite3.connect(other).execute("CREATE TABLE unrelated (x)").connection.close()
    with pytest.raises(LoadError, match="no `repos` table"):
        sqlite_import.load(other, fresh_db, "owner", "Owner")


@pytest.mark.parametrize("slug", ["", "Owner", "has-dash", "x" * 41, "_lead"])
def test_bad_tenant_slugs_are_rejected(slug):
    with pytest.raises(ValueError):
        control.schema_for(slug)


@pytest.mark.parametrize("bad", ["../..", "owner.x/repo", "owner/..", "owner/.", "owner", "a/b/c"])
def test_repo_connection_rejects_unsafe_github_names(fresh_db, sqlite_graph, bad):
    # The value is interpolated into a GitHub API URL, so the database refuses
    # anything that is not a plain owner/name — and the whole load rolls back.
    with pytest.raises(psycopg.errors.CheckViolation):
        sqlite_import.load(
            sqlite_graph, fresh_db, "owner", "Owner", connections=[("sample", bad, None)],
        )


# ── MCP tokens ──────────────────────────────────────────────────────────────


@pytest.fixture
def tenant_db(fresh_db):
    control.ensure_control(fresh_db)
    control.upsert_tenant(fresh_db, "owner", "Owner")
    fresh_db.commit()
    return fresh_db


def test_token_is_stored_only_as_its_hash(tenant_db):
    raw = control.create_token(tenant_db, "owner", "desktop")
    assert raw.startswith(control.TOKEN_PREFIX) and len(raw) > 40
    row = tenant_db.execute("SELECT * FROM control.mcp_tokens").fetchone()
    assert row["token_hash"] == control.hash_token(raw)
    assert row["token_prefix"] == raw[:12]
    assert raw not in {str(v) for v in row.values()}


def test_token_hash_matches_the_app():
    # The vector is what frontend/lib/control.ts computes:
    # createHash("sha256").update("cgk_abc", "utf8").digest("hex")
    assert control.hash_token("cgk_abc") == (
        "86fc44ea38d3befbf36da272b8c1aff5e815e6e02b1b363c77cab0e80c79880a"
    )


def test_tokens_are_unique(tenant_db):
    assert control.create_token(tenant_db, "owner") != control.create_token(tenant_db, "owner")


def test_token_for_unknown_tenant_refused(tenant_db):
    with pytest.raises(LookupError):
        control.create_token(tenant_db, "nobody")


def test_list_and_revoke(tenant_db):
    control.create_token(tenant_db, "owner", "a")
    control.create_token(tenant_db, "owner", "b")
    rows = control.list_tokens(tenant_db, "owner")
    assert [r["label"] for r in rows] == ["a", "b"]
    assert "token_hash" not in rows[0]
    assert control.revoke_token(tenant_db, rows[0]["id"]) is True
    assert control.revoke_token(tenant_db, rows[0]["id"]) is False  # already revoked
    assert control.revoke_token(tenant_db, 999999) is False
    after = control.list_tokens(tenant_db)
    assert after[0]["revoked_at"] is not None and after[1]["revoked_at"] is None
