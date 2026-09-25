"""Load a SQLite graph (the `main`-branch format) into a tenant's Postgres schema.

The SQLite graph that `main` writes to `data/graph.db` and the Postgres graph on
this branch share the same five tables and the same columns, so the load is a
straight copy. It runs as a single transaction: the control schema, the tenant
row, the tenant schema, the rows and the sequence fix-ups commit together or not
at all, so a failure part-way leaves the target exactly as it was.

Rows are streamed from SQLite into Postgres `COPY` one at a time, never loaded
into memory as a whole — the same discipline the indexer keeps.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable

import psycopg
from psycopg import sql

from . import control

# Column order matters: it is the COPY column list on the Postgres side.
GRAPH_TABLES: dict[str, list[str]] = {
    "repos": ["name", "path", "indexed_at", "node_count", "edge_count", "file_count"],
    "nodes": [
        "id", "repo", "kind", "name", "qualified_name", "file_path",
        "start_line", "end_line", "signature",
    ],
    "edges": [
        "id", "repo", "edge_type", "src_qname", "dst_qname", "dst_raw",
        "src_file", "resolved",
    ],
    "files": ["repo", "path", "hash"],
    "imports": ["repo", "file_path", "local_name", "target", "kind"],
}


class LoadError(RuntimeError):
    """Raised for a problem with the input or the target, before anything commits."""


def open_sqlite(path: Path) -> sqlite3.Connection:
    """Open a SQLite graph read-only and check it has the expected shape."""
    if not path.is_file():
        raise LoadError(f"no SQLite file at {path}")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        for table, cols in GRAPH_TABLES.items():
            present = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
            if not present:
                raise LoadError(f"{path} has no `{table}` table — is it a code-graph file?")
            missing = [c for c in cols if c not in present]
            if missing:
                raise LoadError(f"`{table}` in {path} is missing columns: {', '.join(missing)}")
    except Exception:
        con.close()
        raise
    return con


def sqlite_counts(con: sqlite3.Connection) -> dict[str, int]:
    return {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in GRAPH_TABLES}


def _target_counts(pg: psycopg.Connection, schema: str) -> dict[str, int]:
    return {
        t: pg.execute(
            sql.SQL("SELECT COUNT(*) AS n FROM {}.{}").format(
                sql.Identifier(schema), sql.Identifier(t)
            )
        ).fetchone()["n"]
        for t in GRAPH_TABLES
    }


def load(
    sqlite_path: Path,
    pg: psycopg.Connection,
    tenant_slug: str,
    display_name: str,
    *,
    replace: bool = False,
    connections: Iterable[tuple[str, str, str | None]] = (),
) -> dict[str, int]:
    """Copy a SQLite graph into `tenant_<slug>`. Returns the loaded row counts.

    `connections` are (repo_name, "owner/name", git_ref-or-None) triples written
    to `control.repo_connections`, so the app can fetch that repo's source text.

    Refuses to overwrite a tenant that already has a graph unless `replace` is
    set, and refuses an empty source outright.
    """
    lite = open_sqlite(sqlite_path)
    try:
        counts = sqlite_counts(lite)
        if counts["nodes"] == 0:
            raise LoadError(f"{sqlite_path} holds no nodes — refusing to load an empty graph")

        repo_names = {r[0] for r in lite.execute("SELECT name FROM repos")}
        connections = list(connections)
        for repo_name, _, _ in connections:
            if repo_name not in repo_names:
                raise LoadError(
                    f"--github names repo {repo_name!r}, which is not in the graph "
                    f"(have: {', '.join(sorted(repo_names)) or 'none'})"
                )

        with pg.transaction():
            control.ensure_control(pg)
            tenant_id, schema = control.upsert_tenant(pg, tenant_slug, display_name)
            control.ensure_tenant_schema(pg, schema)

            existing = _target_counts(pg, schema)
            if any(existing.values()) and not replace:
                raise LoadError(
                    f"{schema} already holds a graph ({existing['nodes']} nodes). "
                    "Pass --replace to overwrite it."
                )

            pg.execute(
                sql.SQL("TRUNCATE {}").format(
                    sql.SQL(", ").join(
                        sql.Identifier(schema, t) for t in GRAPH_TABLES
                    )
                )
            )

            with pg.cursor() as cur:
                for table, cols in GRAPH_TABLES.items():
                    copy_sql = sql.SQL("COPY {} ({}) FROM STDIN").format(
                        sql.Identifier(schema, table),
                        sql.SQL(", ").join(sql.Identifier(c) for c in cols),
                    )
                    src = lite.execute(f"SELECT {', '.join(cols)} FROM {table}")
                    with cur.copy(copy_sql) as copy:
                        for row in src:
                            copy.write_row(row)

            # COPY wrote explicit ids, so the serial sequences are still at 1
            # and the next insert would collide.
            for table in ("nodes", "edges"):
                pg.execute(
                    sql.SQL(
                        "SELECT setval(pg_get_serial_sequence({qualified}, 'id'), "
                        "GREATEST(COALESCE((SELECT MAX(id) FROM {tbl}), 1), 1))"
                    ).format(
                        qualified=sql.Literal(f"{schema}.{table}"),
                        tbl=sql.Identifier(schema, table),
                    )
                )

            for repo_name, external_repo, git_ref in connections:
                pg.execute(
                    "INSERT INTO control.repo_connections "
                    "(tenant_id, repo_name, provider, external_repo, git_ref) "
                    "VALUES (%s, %s, 'github', %s, %s) "
                    "ON CONFLICT (tenant_id, repo_name) DO UPDATE SET "
                    "external_repo = EXCLUDED.external_repo, git_ref = EXCLUDED.git_ref",
                    (tenant_id, repo_name, external_repo, git_ref),
                )

            loaded = _target_counts(pg, schema)
            if loaded != counts:
                # Raising inside the transaction block rolls everything back.
                raise LoadError(f"row counts differ after load: source {counts}, target {loaded}")
        return loaded
    finally:
        lite.close()
