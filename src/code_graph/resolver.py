"""Call/inherit/type resolution: raw symbol string -> real node qualified name.

The cascade, most-precise first, stopping at the first hit:
  1. Import map      - the source file's own imports (exact binding).
  2. self/cls        - member of the enclosing class.
  3. Same module     - sibling defined in the same file.
  4. Unique in repo  - a single project-wide symbol with that name.
  5. Unresolved      - left honest; no fuzzy/similarity guessing.

Resolution runs after the whole repo is indexed (all nodes exist). It reads via
one connection and writes updates in batches through another, so no write ever
invalidates the streaming read cursor. The read uses a *server-side* cursor:
a client-side one would pull every edge in the repo into memory at execute
time, which is exactly what this project refuses to do. Per-source lookups are
memoized to keep the query count — and it is only ever indexed point lookups —
modest.
"""

from __future__ import annotations

from typing import Optional

import psycopg

from . import db
from .models import (
    EDGE_CALLS,
    EDGE_IMPLEMENTS,
    EDGE_INHERITS,
    EDGE_USES_TYPE,
    KIND_CLASS,
    KIND_FUNCTION,
    KIND_INTERFACE,
    KIND_METHOD,
)

_CALL_KINDS = (KIND_FUNCTION, KIND_METHOD, KIND_CLASS)
_TYPE_KINDS = (KIND_CLASS, KIND_INTERFACE)
_TYPE_EDGES = (EDGE_INHERITS, EDGE_IMPLEMENTS, EDGE_USES_TYPE)
# Edges whose raw destination must be resolved through the cascade.
_RESOLVE_EDGES = (EDGE_CALLS, EDGE_INHERITS, EDGE_IMPLEMENTS, EDGE_USES_TYPE)
# Heads that refer to the enclosing class instance (Python self/cls, JS this).
_SELF_HEADS = ("self", "cls", "this")
_BATCH = 1000


def reset_resolution(con: psycopg.Connection, repo: str) -> None:
    """Restore resolvable edges to their raw, unresolved state (for reindex)."""
    con.execute(
        "UPDATE edges SET dst_qname = dst_raw, resolved = 0 "
        "WHERE repo = %s AND edge_type IN (%s, %s, %s, %s)",
        (repo, *_RESOLVE_EDGES),
    )
    con.commit()


def resolve_repo(write_con: psycopg.Connection, dsn: str, repo: str) -> None:
    """Resolve every CALLS/INHERITS/IMPLEMENTS/USES_TYPE edge, and flag IMPORTS."""
    _flag_imports(write_con, repo)
    _resolve_rooted_assets(write_con, repo)

    read_con = db.connect(dsn)
    try:
        resolver = _Resolver(read_con, repo)
        updates: list[tuple[str, int]] = []
        cur_file: Optional[str] = None
        import_map: dict[str, tuple[str, str]] = {}
        # Named cursor => the rows stream from the server in FETCH-sized
        # chunks instead of all landing in this process at once.
        with read_con.cursor(name="edge_scan") as cur:
            cur.itersize = _BATCH
            cur.execute(
                "SELECT id, edge_type, src_qname, dst_raw, src_file FROM edges "
                "WHERE repo = %s AND edge_type IN (%s, %s, %s, %s) ORDER BY src_file",
                (repo, *_RESOLVE_EDGES),
            )
            while True:
                batch = cur.fetchmany(_BATCH)
                if not batch:
                    break
                for row in batch:
                    if row["src_file"] != cur_file:
                        cur_file = row["src_file"]
                        import_map = resolver.load_import_map(cur_file)
                    dst = resolver.resolve(
                        row["edge_type"], row["src_qname"], row["dst_raw"], import_map
                    )
                    if dst is not None:
                        updates.append((dst, row["id"]))
                if len(updates) >= _BATCH:
                    _flush(write_con, updates)
                    updates.clear()
        if updates:
            _flush(write_con, updates)
    finally:
        read_con.close()


def _flush(con: psycopg.Connection, updates: list[tuple[str, int]]) -> None:
    with con.cursor() as cur:
        cur.executemany(
            "UPDATE edges SET dst_qname = %s, resolved = 1 WHERE id = %s", updates
        )
    con.commit()


def _escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _resolve_rooted_assets(con: psycopg.Connection, repo: str) -> None:
    """Resolve refs whose base is a doc/template *root*, not the repo root.

    Two cases share one mechanism:
    - Absolute asset paths (``/static/app.js``) assume the web doc-root is the
      repo root, but the app is often served from a subdirectory (Flask serves
      ``/static/`` from ``webapp/app/static/``), so the exact-root candidate
      matches no node.
    - Jinja template refs (``{% extends "base.html" %}``) are resolved against
      the template search path, again not the repo root.

    In both, we recover the link when *exactly one* file's path ends with the ref
    as a trailing path-segment sequence — a multi-segment, uniqueness-gated match,
    so an ambiguous ref is left honestly unresolved rather than guessed.

    Updates both the ``imports`` row (so `get_dependencies` reports it in-project)
    and the ``IMPORTS`` edge (so cross-file graph queries connect).
    """
    candidates = con.execute(
        "SELECT file_path, local_name, target FROM imports "
        "WHERE repo = %s AND ("
        "  (kind = 'asset' AND local_name LIKE '/%%') OR kind = 'template'"
        ") AND NOT EXISTS (SELECT 1 FROM nodes n "
        "  WHERE n.repo = imports.repo AND n.qualified_name = imports.target)",
        (repo,),
    ).fetchall()
    if not candidates:
        return

    # Keyed by the imports primary key: Postgres has no implicit rowid.
    import_updates: list[tuple[str, str, str, str]] = []
    edge_updates: list[tuple[str, str, str, str]] = []
    for row in candidates:
        rooted = row["local_name"].lstrip("/").split("?", 1)[0].split("#", 1)[0]
        if not rooted:
            continue
        matches = con.execute(
            "SELECT qualified_name FROM nodes "
            "WHERE repo = %s AND kind = 'File' "
            "AND (file_path = %s OR file_path LIKE %s ESCAPE '\\') LIMIT 2",
            (repo, rooted, "%/" + _escape_like(rooted)),
        ).fetchall()
        if len(matches) == 1:
            new_target = matches[0]["qualified_name"]
            import_updates.append(
                (new_target, repo, row["file_path"], row["local_name"])
            )
            edge_updates.append((new_target, repo, row["file_path"], row["local_name"]))

    with con.cursor() as cur:
        if import_updates:
            cur.executemany(
                "UPDATE imports SET target = %s "
                "WHERE repo = %s AND file_path = %s AND local_name = %s",
                import_updates,
            )
        if edge_updates:
            cur.executemany(
                "UPDATE edges SET dst_qname = %s, resolved = 1 "
                "WHERE repo = %s AND edge_type = 'IMPORTS' AND src_file = %s "
                "AND dst_raw = %s",
                edge_updates,
            )
    con.commit()


def _flag_imports(con: psycopg.Connection, repo: str) -> None:
    con.execute(
        "UPDATE edges SET resolved = CASE WHEN EXISTS ("
        "  SELECT 1 FROM nodes n "
        "  WHERE n.repo = edges.repo AND n.qualified_name = edges.dst_qname"
        ") THEN 1 ELSE 0 END "
        "WHERE repo = %s AND edge_type = 'IMPORTS'",
        (repo,),
    )
    con.commit()


class _Resolver:
    def __init__(self, read_con: psycopg.Connection, repo: str) -> None:
        self._con = read_con
        self._repo = repo
        self._module_cache: dict[str, Optional[str]] = {}
        self._class_cache: dict[str, Optional[str]] = {}
        self._unique_cache: dict[tuple[str, str], Optional[str]] = {}

    def load_import_map(self, file_path: str) -> dict[str, tuple[str, str]]:
        rows = self._con.execute(
            "SELECT local_name, target, kind FROM imports "
            "WHERE repo = %s AND file_path = %s",
            (self._repo, file_path),
        ).fetchall()
        return {r["local_name"]: (r["target"], r["kind"]) for r in rows}

    def resolve(
        self,
        edge_type: str,
        src_qname: str,
        raw: str,
        import_map: dict[str, tuple[str, str]],
    ) -> Optional[str]:
        parts = raw.split(".")
        head = parts[0]

        # 1. Import map: replace the bound head with its import target.
        if head in import_map:
            target, _kind = import_map[head]
            cand = target if len(parts) == 1 else target + "." + ".".join(parts[1:])
            if self._exists(cand):
                return cand

        # 2. self / cls / this -> member of the enclosing class.
        if head in _SELF_HEADS and len(parts) >= 2:
            cls = self._enclosing_class(src_qname)
            if cls:
                cand = cls + "." + parts[1]
                if self._exists(cand):
                    return cand

        # 3. Same-module sibling.
        module = self._module_of(src_qname)
        if module is not None:
            cand = (module + "." + parts[-1]) if module else parts[-1]
            if self._exists(cand):
                return cand

        # 4. Unique symbol of that name anywhere in the repo.
        return self._unique_by_name(parts[-1], edge_type)

    # -- indexed point lookups, memoized ----------------------------------
    def _exists(self, qname: str) -> bool:
        row = self._con.execute(
            "SELECT 1 FROM nodes WHERE repo = %s AND qualified_name = %s LIMIT 1",
            (self._repo, qname),
        ).fetchone()
        return row is not None

    def _enclosing_class(self, src_qname: str) -> Optional[str]:
        if src_qname in self._class_cache:
            return self._class_cache[src_qname]
        result = None
        parts = src_qname.split(".")
        for i in range(len(parts) - 1, 0, -1):
            cand = ".".join(parts[:i])
            row = self._con.execute(
                "SELECT 1 FROM nodes WHERE repo = %s AND qualified_name = %s "
                "AND kind IN (%s, %s) LIMIT 1",
                (self._repo, cand, KIND_CLASS, KIND_INTERFACE),
            ).fetchone()
            if row is not None:
                result = cand
                break
        self._class_cache[src_qname] = result
        return result

    def _module_of(self, src_qname: str) -> Optional[str]:
        if src_qname in self._module_cache:
            return self._module_cache[src_qname]
        result = None
        parts = src_qname.split(".")
        for i in range(len(parts), 0, -1):
            cand = ".".join(parts[:i])
            row = self._con.execute(
                "SELECT 1 FROM nodes WHERE repo = %s AND qualified_name = %s "
                "AND kind = 'File' LIMIT 1",
                (self._repo, cand),
            ).fetchone()
            if row is not None:
                result = cand
                break
        self._module_cache[src_qname] = result
        return result

    def _unique_by_name(self, name: str, edge_type: str) -> Optional[str]:
        key = (name, edge_type)
        if key in self._unique_cache:
            return self._unique_cache[key]
        kinds = _TYPE_KINDS if edge_type in _TYPE_EDGES else _CALL_KINDS
        rows = self._con.execute(
            "SELECT qualified_name FROM nodes "
            "WHERE repo = %s AND name = %s AND kind IN ({}) LIMIT 2".format(
                ",".join(["%s"] * len(kinds))
            ),
            (self._repo, name, *kinds),
        ).fetchall()
        result = rows[0]["qualified_name"] if len(rows) == 1 else None
        self._unique_cache[key] = result
        return result
