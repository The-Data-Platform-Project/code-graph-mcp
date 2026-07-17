"""SQLite storage: schema, connection setup, and the two core graph tables.

Design notes:
- `nodes` and `edges` are the graph; both are indexed on qualified name (nodes on
  their own qname, edges on both src and dst) so caller/callee lookups are a
  single indexed query.
- `repos`, `files` and `imports` are small metadata tables supporting repo
  listing, content-hash incremental reindex, and call resolution respectively.
- The DB stores *structure only* — never source text. `get_code_snippet` reads
  fresh from disk.
- WAL mode with `synchronous=NORMAL`: durable enough for a derived cache, fast to
  write, and allows the host to read `graph.db` while the service runs.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

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
    id             INTEGER PRIMARY KEY,
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
    id         INTEGER PRIMARY KEY,
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


def connect(db_path: Path) -> sqlite3.Connection:
    """Open (creating parent dirs and schema if needed) a configured connection.

    Each call returns an independent connection; callers close it. This keeps
    every connection bound to the thread that opened it, which is what
    `sqlite3`'s default same-thread checking wants when tools run in a
    thread pool.
    """
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(db_path), timeout=30.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.execute("PRAGMA temp_store=MEMORY")
    con.executescript(_SCHEMA)
    return con


def checkpoint(con: sqlite3.Connection) -> None:
    """Fold the WAL back into the main DB file and truncate it.

    Run after a large index so the host sees a compact, self-contained
    graph.db rather than a fat -wal sidecar.
    """
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
