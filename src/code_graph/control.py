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
                      used to fetch source text once the desktop is out of the loop,
                      and whether the indexer refreshes it daily and on push
- `users`, `members`  people who signed in with GitHub, and which tenant each may use
- `github_tokens`     a tenant's fine-grained GitHub tokens, encrypted (secretbox.py);
                      a repo connection names the one that can read its repository
- `index_jobs`        the indexer's work log: one row per index run (etl/jobs.py)

A repository's GitHub coordinates deliberately do not live on the graph's own
`repos` table: `index_full` deletes and recreates that row, so a full reindex
would silently wipe them.

Neither `control` nor any `tenant_*` schema is meant to be reachable through
Supabase's auto-generated API; access is revoked from its client roles below,
and the app connects server-side only.
"""

from __future__ import annotations

import hashlib
import re
import secrets

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

-- People, identified by their GitHub account. Signing in creates a 'pending'
-- row; a platform admin approves it, which provisions the user's own tenant.
CREATE TABLE IF NOT EXISTS control.users (
    id                 BIGSERIAL PRIMARY KEY,
    github_id          BIGINT NOT NULL UNIQUE,
    github_login       TEXT NOT NULL,
    display_name       TEXT,
    email              TEXT,
    avatar_url         TEXT,
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'suspended')),
    is_platform_admin  BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_at        TIMESTAMPTZ,
    last_login_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS control.members (
    tenant_id  BIGINT NOT NULL REFERENCES control.tenants(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES control.users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    PRIMARY KEY (tenant_id, user_id)
);

-- Fine-grained GitHub tokens. A tenant keeps as many as it likes, each scoped
-- on GitHub to its own set of repositories. Only ciphertext is stored
-- (AES-256-GCM under GITHUB_TOKEN_KEY, see secretbox.py); the app needs the
-- plaintext back to call GitHub, so a hash would not do.
CREATE TABLE IF NOT EXISTS control.github_tokens (
    id                BIGSERIAL PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES control.tenants(id) ON DELETE CASCADE,
    created_by        BIGINT REFERENCES control.users(id) ON DELETE SET NULL,
    label             TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
    github_login      TEXT NOT NULL,
    token_ciphertext  TEXT NOT NULL,
    token_hint        TEXT NOT NULL,
    expires_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at   TIMESTAMPTZ,
    last_error        TEXT,
    UNIQUE (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_github_tokens_tenant ON control.github_tokens(tenant_id);

ALTER TABLE control.repo_connections
    ADD COLUMN IF NOT EXISTS github_token_id  BIGINT,
    ADD COLUMN IF NOT EXISTS branch           TEXT,
    ADD COLUMN IF NOT EXISTS index_daily      BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS index_on_push    BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS last_indexed_at  TIMESTAMPTZ;

-- The token must belong to the connection's own tenant: the composite key
-- makes "tenant A's repo read with tenant B's token" unrepresentable.
-- Deleting a token clears only the token column, never the tenant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repo_connections_token_fk') THEN
    ALTER TABLE control.repo_connections
      ADD CONSTRAINT repo_connections_token_fk
      FOREIGN KEY (github_token_id, tenant_id)
      REFERENCES control.github_tokens (id, tenant_id)
      ON DELETE SET NULL (github_token_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_repo_connections_external
    ON control.repo_connections (lower(external_repo));

CREATE TABLE IF NOT EXISTS control.index_jobs (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    repo_name    TEXT NOT NULL,
    trigger      TEXT NOT NULL CHECK (trigger IN ('schedule', 'push', 'manual')),
    status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    commit_sha   TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    stats        JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    FOREIGN KEY (tenant_id, repo_name)
        REFERENCES control.repo_connections (tenant_id, repo_name) ON DELETE CASCADE
);

-- At most one queued job per repo: a burst of pushes collapses into one run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_index_jobs_one_queued
    ON control.index_jobs (tenant_id, repo_name) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_index_jobs_recent
    ON control.index_jobs (tenant_id, created_at DESC);
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


def _provision_function() -> str:
    """`control.provision_tenant(slug, display_name)`, for the app's restricted role.

    Approving a sign-up has to create a schema, which the app's role may not do.
    This SECURITY DEFINER function does exactly that and nothing more: validate
    the slug, upsert the tenant row, create `tenant_<slug>` with the graph
    tables, keep Supabase's API roles out, and let the caller read it. The
    graph DDL is `db._SCHEMA` itself, embedded when the function is (re)created,
    so it cannot drift from what the indexer writes.
    """
    return f"""
CREATE OR REPLACE FUNCTION control.provision_tenant(p_slug text, p_display text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_schema text := 'tenant_' || p_slug;
  v_id     bigint;
  r        text;
BEGIN
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9][a-z0-9_]{{0,39}}$' THEN
    RAISE EXCEPTION 'invalid tenant slug %', p_slug;
  END IF;
  INSERT INTO control.tenants (slug, schema_name, display_name)
  VALUES (p_slug, v_schema, p_display)
  ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
  RETURNING id INTO v_id;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema);
  -- Local to this function call: the SET clause above restores it on exit.
  PERFORM set_config('search_path', quote_ident(v_schema), true);
  EXECUTE $graph_ddl${db._SCHEMA}$graph_ddl$;
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);

  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', v_schema, r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', v_schema, r);
    END IF;
  END LOOP;
  IF session_user <> current_user THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', v_schema, session_user);
    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', v_schema, session_user);
  END IF;
  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION control.provision_tenant(text, text) FROM PUBLIC;
"""


def ensure_control(con: psycopg.Connection) -> None:
    """Create the control schema if it is missing. Runs in the caller's transaction."""
    con.execute(CONTROL_SCHEMA)
    con.execute(_provision_function())
    _revoke_client_roles(con, "control")


# The tables the app writes on a user's behalf. Everything else in `control`
# it may only read (plus mcp_tokens.last_used_at).
APP_WRITABLE = ("users", "members", "github_tokens", "repo_connections", "index_jobs")


def grant_app_role(con: psycopg.Connection, role: str) -> None:
    """Give the app's login role exactly what the web app needs, and no more.

    Read the control plane; write users, memberships, GitHub tokens, repo
    connections and index jobs; provision tenants through the one function
    that may create schemas. It never gets DDL rights or another tenant's
    graph beyond SELECT on what it is granted per schema.
    """
    ident = sql.Identifier(role)
    con.execute(sql.SQL("GRANT USAGE ON SCHEMA control TO {}").format(ident))
    con.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA control TO {}").format(ident))
    con.execute(
        sql.SQL("GRANT UPDATE (last_used_at) ON control.mcp_tokens TO {}").format(ident)
    )
    for table in APP_WRITABLE:
        con.execute(
            sql.SQL("GRANT INSERT, UPDATE, DELETE ON {} TO {}").format(
                sql.Identifier("control", table), ident
            )
        )
    con.execute(
        sql.SQL("GRANT USAGE ON ALL SEQUENCES IN SCHEMA control TO {}").format(ident)
    )
    con.execute(
        sql.SQL("GRANT EXECUTE ON FUNCTION control.provision_tenant(text, text) TO {}").format(
            ident
        )
    )
    for row in con.execute("SELECT schema_name FROM control.tenants").fetchall():
        schema = sql.Identifier(row["schema_name"])
        con.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(schema, ident))
        con.execute(
            sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(schema, ident)
        )


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


# ── MCP tokens ──────────────────────────────────────────────────────────────
# A token is shown once, at creation, and only its SHA-256 is kept. The app
# (frontend/lib/control.ts) hashes the presented bearer the same way.

TOKEN_PREFIX = "cgk_"


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def create_token(con: psycopg.Connection, slug: str, label: str = "") -> str:
    """Mint a token for an existing tenant. Returns the raw token, which is not stored."""
    row = con.execute(
        "SELECT id FROM control.tenants WHERE slug = %s", (validate_slug(slug),)
    ).fetchone()
    if row is None:
        raise LookupError(f"no tenant {slug!r}; load its graph first")
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    con.execute(
        "INSERT INTO control.mcp_tokens (tenant_id, token_hash, token_prefix, label) "
        "VALUES (%s, %s, %s, %s)",
        (row["id"], hash_token(raw), raw[:12], label),
    )
    return raw


def list_tokens(con: psycopg.Connection, slug: str | None = None) -> list[dict]:
    sql_text = (
        "SELECT k.id, t.slug AS tenant, k.token_prefix, k.label, k.created_at, "
        "k.last_used_at, k.revoked_at FROM control.mcp_tokens k "
        "JOIN control.tenants t ON t.id = k.tenant_id"
    )
    params: list = []
    if slug:
        sql_text += " WHERE t.slug = %s"
        params.append(slug)
    return con.execute(sql_text + " ORDER BY k.id", params).fetchall()


def revoke_token(con: psycopg.Connection, token_id: int) -> bool:
    """Revoke by id. True if a live token was revoked."""
    cur = con.execute(
        "UPDATE control.mcp_tokens SET revoked_at = now() "
        "WHERE id = %s AND revoked_at IS NULL",
        (token_id,),
    )
    return cur.rowcount == 1
