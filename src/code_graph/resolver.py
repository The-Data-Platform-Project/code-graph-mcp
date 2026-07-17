"""Call/inherit/type resolution: raw symbol string -> real node qualified name.

The cascade, most-precise first, stopping at the first hit:
  1. Import map      - the source file's own imports (exact binding).
  2. self/cls        - member of the enclosing class.
  3. Same module     - sibling defined in the same file.
  4. Unique in repo  - a single project-wide symbol with that name.
  5. Unresolved      - left honest; no fuzzy/similarity guessing.

Resolution runs after the whole repo is indexed (all nodes exist). It reads via
one connection and writes updates in batches through another, so no write ever
invalidates the streaming read cursor. Per-source lookups are memoized to keep
the query count — and it is only ever indexed point lookups — modest.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Optional

from . import db
from .models import (
    EDGE_CALLS,
    EDGE_INHERITS,
    EDGE_USES_TYPE,
    KIND_CLASS,
    KIND_FUNCTION,
    KIND_INTERFACE,
    KIND_METHOD,
)

_CALL_KINDS = (KIND_FUNCTION, KIND_METHOD, KIND_CLASS)
_TYPE_KINDS = (KIND_CLASS, KIND_INTERFACE)
_BATCH = 1000


def reset_resolution(con: sqlite3.Connection, repo: str) -> None:
    """Restore resolvable edges to their raw, unresolved state (for reindex)."""
    con.execute(
        "UPDATE edges SET dst_qname = dst_raw, resolved = 0 "
        "WHERE repo = ? AND edge_type IN (?, ?, ?)",
        (repo, EDGE_CALLS, EDGE_INHERITS, EDGE_USES_TYPE),
    )
    con.commit()


def resolve_repo(write_con: sqlite3.Connection, db_path: Path, repo: str) -> None:
    """Resolve every CALLS/INHERITS/USES_TYPE edge for `repo`, and flag IMPORTS."""
    _flag_imports(write_con, repo)

    read_con = db.connect(db_path)
    try:
        resolver = _Resolver(read_con, repo)
        cur = read_con.execute(
            "SELECT id, edge_type, src_qname, dst_raw, src_file FROM edges "
            "WHERE repo = ? AND edge_type IN (?, ?, ?) ORDER BY src_file",
            (repo, EDGE_CALLS, EDGE_INHERITS, EDGE_USES_TYPE),
        )
        updates: list[tuple[str, int]] = []
        cur_file: Optional[str] = None
        import_map: dict[str, tuple[str, str]] = {}
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


def _flush(con: sqlite3.Connection, updates: list[tuple[str, int]]) -> None:
    con.executemany(
        "UPDATE edges SET dst_qname = ?, resolved = 1 WHERE id = ?", updates
    )
    con.commit()


def _flag_imports(con: sqlite3.Connection, repo: str) -> None:
    con.execute(
        "UPDATE edges SET resolved = CASE WHEN EXISTS ("
        "  SELECT 1 FROM nodes n "
        "  WHERE n.repo = edges.repo AND n.qualified_name = edges.dst_qname"
        ") THEN 1 ELSE 0 END "
        "WHERE repo = ? AND edge_type = 'IMPORTS'",
        (repo,),
    )
    con.commit()


class _Resolver:
    def __init__(self, read_con: sqlite3.Connection, repo: str) -> None:
        self._con = read_con
        self._repo = repo
        self._module_cache: dict[str, Optional[str]] = {}
        self._class_cache: dict[str, Optional[str]] = {}
        self._unique_cache: dict[tuple[str, str], Optional[str]] = {}

    def load_import_map(self, file_path: str) -> dict[str, tuple[str, str]]:
        rows = self._con.execute(
            "SELECT local_name, target, kind FROM imports "
            "WHERE repo = ? AND file_path = ?",
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

        # 2. self / cls -> member of the enclosing class.
        if head in ("self", "cls") and len(parts) >= 2:
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
            "SELECT 1 FROM nodes WHERE repo = ? AND qualified_name = ? LIMIT 1",
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
                "SELECT 1 FROM nodes WHERE repo = ? AND qualified_name = ? "
                "AND kind IN (?, ?) LIMIT 1",
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
                "SELECT 1 FROM nodes WHERE repo = ? AND qualified_name = ? "
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
        kinds = _TYPE_KINDS if edge_type in (EDGE_INHERITS, EDGE_USES_TYPE) else _CALL_KINDS
        rows = self._con.execute(
            "SELECT qualified_name FROM nodes "
            "WHERE repo = ? AND name = ? AND kind IN ({}) LIMIT 2".format(
                ",".join("?" * len(kinds))
            ),
            (self._repo, name, *kinds),
        ).fetchall()
        result = rows[0]["qualified_name"] if len(rows) == 1 else None
        self._unique_cache[key] = result
        return result
