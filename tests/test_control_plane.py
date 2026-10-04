"""The control plane's sign-up and token tables, and what the app's role may do.

The web app connects as a restricted role (docs/ADMIN_GUIDE.md §2.2). These
tests run as such a role, created per test, because the point of
`grant_app_role` and `control.provision_tenant` is what that role can and
cannot do.
"""

from __future__ import annotations

import uuid
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from psycopg.rows import dict_row

from code_graph import control, secretbox
from code_graph.etl import jobs

from conftest import TEST_DATABASE_URL


@pytest.fixture
def ready(fresh_db):
    control.ensure_control(fresh_db)
    fresh_db.commit()
    return fresh_db


@pytest.fixture
def app_con(ready, fresh_dsn):
    """A connection as a freshly granted app role, like the deployed web app's."""
    role = f"app_{uuid.uuid4().hex[:8]}"
    admin = psycopg.connect(TEST_DATABASE_URL, autocommit=True)
    admin.execute(f'CREATE ROLE "{role}" LOGIN')
    control.grant_app_role(ready, role)
    ready.commit()
    parts = urlsplit(fresh_dsn)
    netloc = f"{role}@{parts.hostname}:{parts.port or 5432}"
    con = psycopg.connect(urlunsplit(parts._replace(netloc=netloc)), row_factory=dict_row)
    try:
        yield con
    finally:
        con.close()
        ready.rollback()
        ready.execute(f'DROP OWNED BY "{role}"')
        ready.execute(f'REVOKE ALL ON ALL TABLES IN SCHEMA control FROM "{role}"')
        ready.commit()
        ready.close()  # the role's grants live in this database, dropped next
        admin.execute(f'DROP ROLE IF EXISTS "{role}"')
        admin.close()


def test_ensure_control_is_idempotent(ready):
    control.ensure_control(ready)
    control.ensure_control(ready)
    ready.commit()
    cols = {
        r["column_name"]
        for r in ready.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'control' AND table_name = 'repo_connections'"
        ).fetchall()
    }
    assert {"github_token_id", "branch", "index_daily", "index_on_push"} <= cols


def test_app_role_provisions_a_tenant_through_the_function(app_con):
    tenant_id = app_con.execute(
        "SELECT control.provision_tenant('gh_42', 'octocat') AS id"
    ).fetchone()["id"]
    app_con.commit()
    assert tenant_id > 0
    # The graph tables exist in the new schema, and the app may read them.
    assert app_con.execute("SELECT COUNT(*) AS n FROM tenant_gh_42.nodes").fetchone()["n"] == 0
    # Re-provisioning is harmless.
    again = app_con.execute(
        "SELECT control.provision_tenant('gh_42', 'octocat') AS id"
    ).fetchone()["id"]
    assert again == tenant_id


def test_provision_refuses_a_bad_slug(app_con):
    with pytest.raises(psycopg.errors.RaiseException):
        app_con.execute("SELECT control.provision_tenant('x; DROP SCHEMA control', 'x')")


def test_app_role_cannot_create_schemas_or_tenants_directly(app_con):
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        app_con.execute("CREATE SCHEMA tenant_sneaky")
    app_con.rollback()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        app_con.execute(
            "INSERT INTO control.tenants (slug, schema_name, display_name) "
            "VALUES ('x', 'tenant_x', 'x')"
        )


def test_app_role_writes_users_tokens_and_connections(app_con):
    tenant_id = app_con.execute(
        "SELECT control.provision_tenant('gh_7', 'mona') AS id"
    ).fetchone()["id"]
    user_id = app_con.execute(
        "INSERT INTO control.users (github_id, github_login, status) "
        "VALUES (7, 'mona', 'active') RETURNING id"
    ).fetchone()["id"]
    app_con.execute(
        "INSERT INTO control.members (tenant_id, user_id, role) VALUES (%s, %s, 'owner')",
        (tenant_id, user_id),
    )
    token_id = app_con.execute(
        "INSERT INTO control.github_tokens (tenant_id, created_by, label, github_login, "
        "token_ciphertext, token_hint) VALUES (%s, %s, 'work', 'mona', 'v1.x.y', 'abcd') "
        "RETURNING id",
        (tenant_id, user_id),
    ).fetchone()["id"]
    app_con.execute(
        "INSERT INTO control.repo_connections (tenant_id, repo_name, external_repo, "
        "github_token_id) VALUES (%s, 'svc', 'mona/svc', %s)",
        (tenant_id, token_id),
    )
    app_con.execute(
        "INSERT INTO control.index_jobs (tenant_id, repo_name, trigger) "
        "VALUES (%s, 'svc', 'manual')",
        (tenant_id,),
    )
    app_con.commit()


def _tenant(con, slug):
    tenant_id, schema = control.upsert_tenant(con, slug, slug)
    control.ensure_tenant_schema(con, schema)
    return tenant_id


def _token(con, tenant_id, label="t"):
    return con.execute(
        "INSERT INTO control.github_tokens (tenant_id, label, github_login, "
        "token_ciphertext, token_hint) VALUES (%s, %s, 'me', 'v1.a.b', 'zzzz') RETURNING id",
        (tenant_id, label),
    ).fetchone()["id"]


def test_a_connection_cannot_use_another_tenants_token(ready):
    a = _tenant(ready, "a")
    b = _tenant(ready, "b")
    b_token = _token(ready, b)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        ready.execute(
            "INSERT INTO control.repo_connections (tenant_id, repo_name, external_repo, "
            "github_token_id) VALUES (%s, 'r', 'o/r', %s)",
            (a, b_token),
        )


def test_deleting_a_token_keeps_the_connection(ready):
    a = _tenant(ready, "a")
    tok = _token(ready, a)
    ready.execute(
        "INSERT INTO control.repo_connections (tenant_id, repo_name, external_repo, "
        "github_token_id) VALUES (%s, 'r', 'o/r', %s)",
        (a, tok),
    )
    ready.execute("DELETE FROM control.github_tokens WHERE id = %s", (tok,))
    row = ready.execute(
        "SELECT tenant_id, github_token_id FROM control.repo_connections"
    ).fetchone()
    assert row == {"tenant_id": a, "github_token_id": None}


def test_one_queued_job_per_repo(ready):
    a = _tenant(ready, "a")
    ready.execute(
        "INSERT INTO control.repo_connections (tenant_id, repo_name, external_repo) "
        "VALUES (%s, 'r', 'o/r')",
        (a,),
    )
    first = jobs.enqueue(ready, a, "r", "push")
    assert first is not None
    assert jobs.enqueue(ready, a, "r", "push") is None
    # Once it is running, the next push may queue another.
    ready.execute("UPDATE control.index_jobs SET status = 'running' WHERE id = %s", (first,))
    assert jobs.enqueue(ready, a, "r", "schedule") is not None


def test_secretbox_round_trip_and_tenant_binding():
    key = bytes(range(32))
    sealed = secretbox.seal(key, "github_pat_example", secretbox.token_aad(5))
    assert sealed.startswith("v1.")
    assert secretbox.open_sealed(key, sealed, secretbox.token_aad(5)) == "github_pat_example"
    with pytest.raises(ValueError):
        secretbox.open_sealed(key, sealed, secretbox.token_aad(6))
    with pytest.raises(ValueError):
        secretbox.open_sealed(bytes(32), sealed, secretbox.token_aad(5))


def test_secretbox_opens_what_the_app_sealed():
    """A value sealed by frontend/lib/secretbox.ts (Node), so the formats cannot drift."""
    key = secretbox.parse_key("00" * 16 + "ff" * 16)
    sealed = (
        "v1.MhuljeAwaO1JfLoZ."
        "WNvrALC1KgvU1m2kgpkn-MGCZDZB6pvVO1L8dP6K_GoX3r6C"
    )
    assert secretbox.open_sealed(key, sealed, secretbox.token_aad(42)) == "github_pat_from_node"


def test_parse_key_rejects_short_keys():
    with pytest.raises(ValueError):
        secretbox.parse_key("abcd")
