"""Postgres storage: schema, connection setup, and the two core graph tables.

Design notes:
- `nodes` and `edges` are the graph; both are indexed on qualified name (nodes on
  their own qname, edges on both src and dst) so caller/callee lookups are a
  single indexed query.
- `repos`, `files` and `imports` are small metadata tables supporting repo
  listing, content-hash incremental reindex, and call resolution respectively.
- The DB stores *structure only* — never source text. `get_code_snippet` reads
  fresh from disk.
- Rows come back as dicts (`dict_row`), so every query in this package accesses
  columns by name.

Postgres rather than SQLite because the graph is now read directly by the
Next.js app — locally over the compose network, and in production by Vercel
against a hosted database (see docs/SUPABASE.md). A file-backed SQLite graph
cannot be reached from either.
"""

from __future__ import annotations

import psycopg
from psycopg.rows import dict_row

_SCHEMA = """
CREATE TABLE IF NOT EXISTS repos (
    name        TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    indexed_at  TEXT,
    node_count  INTEGER NOT NULL DEFAULT 0,
    edge_count  INTEGER NOT NULL DEFAULT 0,
    file_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
    id             BIGSERIAL PRIMARY KEY,
    repo           TEXT NOT NULL,
    kind           TEXT NOT NULL,
    name           TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    start_line     INTEGER NOT NULL,
    end_line       INTEGER NOT NULL,
    signature      TEXT
);

CREATE TABLE IF NOT EXISTS edges (
    id         BIGSERIAL PRIMARY KEY,
    repo       TEXT NOT NULL,
    edge_type  TEXT NOT NULL,
    src_qname  TEXT NOT NULL,
    dst_qname  TEXT NOT NULL,
    dst_raw    TEXT NOT NULL,
    src_file   TEXT NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
    repo  TEXT NOT NULL,
    path  TEXT NOT NULL,
    hash  TEXT NOT NULL,
    PRIMARY KEY (repo, path)
);

CREATE TABLE IF NOT EXISTS imports (
    repo        TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    local_name  TEXT NOT NULL,
    target      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    PRIMARY KEY (repo, file_path, local_name)
);

CREATE INDEX IF NOT EXISTS idx_nodes_qname        ON nodes(repo, qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_qname_global ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_name         ON nodes(repo, name);
CREATE INDEX IF NOT EXISTS idx_nodes_file         ON nodes(repo, file_path);

CREATE INDEX IF NOT EXISTS idx_edges_src        ON edges(repo, src_qname, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_dst        ON edges(repo, dst_qname, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_dst_global ON edges(dst_qname, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_srcfile    ON edges(repo, src_file);

CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(repo, file_path);
"""

# An arbitrary but fixed key, so concurrent starters serialize their DDL
# instead of racing `CREATE TABLE IF NOT EXISTS` against each other.
_SCHEMA_LOCK_KEY = 0x6367_0001

# DSNs whose schema this process has already ensured. SQLite re-ran its DDL on
# every connect for free; in Postgres that is a catalog round trip per tool
# call, so it is done once per process per DSN instead.
_ready: set[str] = set()


def connect(dsn: str) -> psycopg.Connection:
    """Open a configured connection, creating the schema on first use.

    Each call returns an independent connection; callers close it.
    """
    con = psycopg.connect(dsn, row_factory=dict_row)
    if dsn not in _ready:
        try:
            init_schema(con)
        except Exception:
            con.close()
            raise
        _ready.add(dsn)
    return con


def init_schema(con: psycopg.Connection) -> None:
    """Create the tables and indexes if they are not already present."""
    with con.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (_SCHEMA_LOCK_KEY,))
        cur.execute(_SCHEMA)
    con.commit()


def reset_schema_cache() -> None:
    """Forget which DSNs have been initialized (tests build fresh schemas)."""
    _ready.clear()
