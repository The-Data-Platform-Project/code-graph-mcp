"""The control plane: which tenants exist, and how each one is reached.

Tenancy is a Postgres schema. Every tenant's graph lives in its own schema
(`tenant_<slug>`) holding the ordinary graph tables from `db.py`, so the graph
code needs no tenant column anywhere — pointing a connection's search_path, or a
query's schema qualifier, at the right schema is the whole of tenant isolation.

The `control` schema holds what is *configuration* rather than derived graph
data, and therefore must survive a reindex:

- `tenants`           one row per tenant, naming its schema
- `mcp_tokens`        hashed bearer tokens; a token resolves to exactly one tenant
- `repo_connections`  where a tenant's repository comes from (e.g. a GitHub repo),
                      used to fetch source text once the desktop is out of the loop

A repository's GitHub coordinates deliberately do not live on the graph's own
`repos` table: `index_full` deletes and recreates that row, so a full reindex
would silently wipe them.

Neither `control` nor any `tenant_*` schema is meant to be reachable through
Supabase's auto-generated API; access is revoked from its client roles below,
and the app connects server-side only.
"""

from __future__ import annotations

import re

import psycopg
from psycopg import sql

from . import db

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,39}$")
SCHEMA_RE = re.compile(r"^tenant_[a-z0-9_]{1,40}$")

CONTROL_SCHEMA = """
CREATE SCHEMA IF NOT EXISTS control;

CREATE TABLE IF NOT EXISTS control.tenants (
    id            BIGSERIAL PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9_]{0,39}$'),
    schema_name   TEXT NOT NULL UNIQUE CHECK (schema_name ~ '^tenant_[a-z0-9_]{1,40}$'),
    display_name  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw tokens are never stored. They are 256-bit random values, so a plain
-- SHA-256 is the right hash here: there is no low-entropy secret to stretch.
CREATE TABLE IF NOT EXISTS control.mcp_tokens (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES control.tenants(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    token_prefix  TEXT NOT NULL,
    label         TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS control.repo_connections (
    tenant_id      BIGINT NOT NULL REFERENCES control.tenants(id) ON DELETE CASCADE,
    repo_name      TEXT NOT NULL,
    provider       TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github')),
    -- GitHub owners are letters, digits and hyphens; repo names may also hold
    -- . and _ but can never be "." or "..". Checked because the value is
    -- interpolated into a GitHub API URL.
    external_repo  TEXT NOT NULL CHECK (
                       external_repo ~ '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'
                       AND split_part(external_repo, '/', 2) NOT IN ('.', '..')
                   ),
    git_ref        TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, repo_name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_tenant ON control.mcp_tokens(tenant_id);
"""


def validate_slug(slug: str) -> str:
    if not SLUG_RE.match(slug or ""):
        raise ValueError(
            f"invalid tenant slug {slug!r}: lowercase letters, digits and _, "
            "starting with a letter or digit, at most 40 characters"
        )
    return slug


def schema_for(slug: str) -> str:
    """The schema a tenant's graph lives in."""
    return f"tenant_{validate_slug(slug)}"


def _revoke_client_roles(con: psycopg.Connection, schema: str) -> None:
    """Keep a schema out of reach of Supabase's anon/authenticated API roles.

    Those roles only exist on Supabase, so this is a no-op on plain Postgres.
    """
    con.execute(
        sql.SQL(
            """
            DO $$
            DECLARE r text;
            BEGIN
              FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
                  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', {schema}, r);
                  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', {schema}, r);
                END IF;
              END LOOP;
            END $$;
            """
        ).format(schema=sql.Literal(schema))
    )


def ensure_control(con: psycopg.Connection) -> None:
    """Create the control schema if it is missing. Runs in the caller's transaction."""
    con.execute(CONTROL_SCHEMA)
    _revoke_client_roles(con, "control")


def upsert_tenant(
    con: psycopg.Connection, slug: str, display_name: str
) -> tuple[int, str]:
    """Create (or fetch) a tenant row. Returns (tenant_id, schema_name)."""
    schema = schema_for(slug)
    row = con.execute(
        "INSERT INTO control.tenants (slug, schema_name, display_name) "
        "VALUES (%s, %s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name "
        "RETURNING id, schema_name",
        (slug, schema, display_name),
    ).fetchone()
    return row["id"], row["schema_name"]


def ensure_tenant_schema(con: psycopg.Connection, schema: str) -> None:
    """Create a tenant's schema and its graph tables, in the caller's transaction.

    The graph DDL is `db._SCHEMA`, applied with the search_path pointed at the
    tenant — the same DDL the indexer uses, so the two cannot drift.
    """
    if not SCHEMA_RE.match(schema):
        raise ValueError(f"invalid tenant schema name {schema!r}")
    con.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS {}").format(sql.Identifier(schema)))
    con.execute(sql.SQL("SET LOCAL search_path TO {}").format(sql.Identifier(schema)))
    con.execute("SET LOCAL client_min_messages = warning")
    con.execute(db._SCHEMA)
    con.execute("SET LOCAL search_path TO DEFAULT")
    _revoke_client_roles(con, schema)
