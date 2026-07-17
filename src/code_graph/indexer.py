"""Indexing pipeline.

Memory discipline (the load-bearing part of this project):
- Files are discovered with an `os.walk` generator; the full list is never
  materialized.
- Each file is parsed, extracted, its rows buffered, and its parse tree dropped
  before the next file is read. No tree is ever held across files.
- Rows are flushed to SQLite every `commit_batch_files` files, so pending state
  is bounded to a couple hundred files' worth of small tuples, not the repo.
- Buffers hold plain tuples ready for `executemany`, not objects that reference
  the tree.

`index_full` rebuilds a repo from scratch; `reindex` re-parses only files whose
content hash changed (and drops deleted ones), then re-resolves the repo.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from . import db, resolver
from .config import Config
from .languages import get_extractor, get_parser, is_supported
from .models import FileResult

# Directories never worth walking into.
_PRUNE_DIRS = frozenset(
    {
        "__pycache__", "node_modules", "venv", "env", ".env",
        "dist", "build", ".eggs", "site-packages", ".hg", ".svn",
    }
)


@dataclass
class IndexResult:
    repo: str
    files_indexed: int
    files_skipped: int
    files_deleted: int
    nodes: int
    edges: int
    status: str


class Indexer:
    def __init__(self, config: Config) -> None:
        self._config = config

    # -- public operations -------------------------------------------------
    def index_full(self, name: str, abs_root: Path, rel_path: str) -> IndexResult:
        con = db.connect(self._config.db_path)
        try:
            _clear_repo(con, name)
            files_indexed, files_skipped = self._ingest(con, name, abs_root)
            resolver.resolve_repo(con, self._config.db_path, name)
            nodes, edges = _finalize(con, name, rel_path)
            db.checkpoint(con)
            return IndexResult(
                repo=name,
                files_indexed=files_indexed,
                files_skipped=files_skipped,
                files_deleted=0,
                nodes=nodes,
                edges=edges,
                status="indexed",
            )
        finally:
            con.close()

    def reindex(self, name: str, abs_root: Path, rel_path: str) -> IndexResult:
        con = db.connect(self._config.db_path)
        try:
            known = {
                row["path"]: row["hash"]
                for row in con.execute(
                    "SELECT path, hash FROM files WHERE repo = ?", (name,)
                )
            }
            seen: set[str] = set()
            changed = 0
            skipped = 0
            for abs_file, rel in _walk_source_files(abs_root):
                seen.add(rel)
                data = _read_capped(abs_file, self._config.max_file_bytes)
                if data is None:
                    skipped += 1
                    continue
                digest = hashlib.sha256(data).hexdigest()
                if known.get(rel) == digest:
                    continue  # unchanged
                _drop_file(con, name, rel)
                self._ingest_one(con, name, rel, data, digest)
                changed += 1
            deleted = 0
            for rel in known.keys() - seen:
                _drop_file(con, name, rel)
                deleted += 1
            con.commit()

            # Resolution is repo-global; reset and rerun so cross-file edges
            # stay consistent after adds/removes.
            resolver.reset_resolution(con, name)
            resolver.resolve_repo(con, self._config.db_path, name)
            nodes, edges = _finalize(con, name, rel_path)
            db.checkpoint(con)
            return IndexResult(
                repo=name,
                files_indexed=changed,
                files_skipped=skipped,
                files_deleted=deleted,
                nodes=nodes,
                edges=edges,
                status="reindexed",
            )
        finally:
            con.close()

    # -- ingestion ---------------------------------------------------------
    def _ingest(self, con, name: str, abs_root: Path) -> tuple[int, int]:
        indexed = 0
        skipped = 0
        node_buf: list[tuple] = []
        edge_buf: list[tuple] = []
        import_buf: list[tuple] = []
        file_buf: list[tuple] = []

        def flush() -> None:
            if node_buf:
                con.executemany(
                    "INSERT INTO nodes(repo,kind,name,qualified_name,file_path,"
                    "start_line,end_line,signature) VALUES(?,?,?,?,?,?,?,?)",
                    node_buf,
                )
                node_buf.clear()
            if edge_buf:
                con.executemany(
                    "INSERT INTO edges(repo,edge_type,src_qname,dst_qname,dst_raw,"
                    "src_file,resolved) VALUES(?,?,?,?,?,?,?)",
                    edge_buf,
                )
                edge_buf.clear()
            if import_buf:
                con.executemany(
                    "INSERT OR REPLACE INTO imports(repo,file_path,local_name,"
                    "target,kind) VALUES(?,?,?,?,?)",
                    import_buf,
                )
                import_buf.clear()
            if file_buf:
                con.executemany(
                    "INSERT OR REPLACE INTO files(repo,path,hash) VALUES(?,?,?)",
                    file_buf,
                )
                file_buf.clear()
            con.commit()

        batch_size = self._config.commit_batch_files
        since_flush = 0
        for abs_file, rel in _walk_source_files(abs_root):
            data = _read_capped(abs_file, self._config.max_file_bytes)
            if data is None:
                skipped += 1
                continue
            digest = hashlib.sha256(data).hexdigest()
            result = _parse_and_extract(rel, data)
            if result is None:
                skipped += 1
                continue
            _buffer(name, rel, digest, result, node_buf, edge_buf, import_buf, file_buf)
            indexed += 1
            since_flush += 1
            if since_flush >= batch_size:
                flush()
                since_flush = 0
        flush()
        return indexed, skipped

    def _ingest_one(self, con, name: str, rel: str, data: bytes, digest: str) -> None:
        result = _parse_and_extract(rel, data)
        if result is None:
            return
        node_buf: list[tuple] = []
        edge_buf: list[tuple] = []
        import_buf: list[tuple] = []
        file_buf: list[tuple] = []
        _buffer(name, rel, digest, result, node_buf, edge_buf, import_buf, file_buf)
        con.executemany(
            "INSERT INTO nodes(repo,kind,name,qualified_name,file_path,"
            "start_line,end_line,signature) VALUES(?,?,?,?,?,?,?,?)",
            node_buf,
        )
        con.executemany(
            "INSERT INTO edges(repo,edge_type,src_qname,dst_qname,dst_raw,"
            "src_file,resolved) VALUES(?,?,?,?,?,?,?)",
            edge_buf,
        )
        if import_buf:
            con.executemany(
                "INSERT OR REPLACE INTO imports(repo,file_path,local_name,"
                "target,kind) VALUES(?,?,?,?,?)",
                import_buf,
            )
        con.executemany(
            "INSERT OR REPLACE INTO files(repo,path,hash) VALUES(?,?,?)", file_buf
        )


# --- module-level helpers --------------------------------------------------
def _walk_source_files(abs_root: Path) -> Iterator[tuple[Path, str]]:
    """Yield (absolute_path, repo_relative_posix_path) for supported files.

    Uses os.walk (a generator) and prunes noise/dot directories in place so the
    file list is never fully materialized. Symlinks are not followed, which
    avoids escaping the repo and walk cycles.
    """
    root = str(abs_root)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [
            d for d in dirnames if not d.startswith(".") and d not in _PRUNE_DIRS
        ]
        for fn in filenames:
            ext = os.path.splitext(fn)[1]
            if not is_supported(ext):
                continue
            abs_file = Path(dirpath) / fn
            rel = abs_file.relative_to(abs_root).as_posix()
            yield abs_file, rel


def _read_capped(path: Path, max_bytes: int) -> bytes | None:
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if size > max_bytes:
        return None
    try:
        return path.read_bytes()
    except OSError:
        return None


def _parse_and_extract(rel: str, data: bytes) -> FileResult | None:
    ext = os.path.splitext(rel)[1]
    parser = get_parser(ext)
    extractor = get_extractor(ext)
    if parser is None or extractor is None:
        return None
    tree = parser.parse(data)
    try:
        return extractor.extract(tree, data, rel)
    finally:
        # Drop the tree explicitly before the next file is touched.
        del tree


def _buffer(
    name, rel, digest, result, node_buf, edge_buf, import_buf, file_buf
) -> None:
    for nd in result.nodes:
        node_buf.append(
            (
                name, nd.kind, nd.name, nd.qualified_name, nd.file_path,
                nd.start_line, nd.end_line, nd.signature,
            )
        )
    for e in result.edges:
        edge_buf.append(
            (
                name, e.edge_type, e.src_qname, e.dst_qname, e.dst_raw,
                e.src_file, e.resolved,
            )
        )
    for im in result.imports:
        import_buf.append((name, im.file_path, im.local_name, im.target, im.kind))
    file_buf.append((name, rel, digest))


def _clear_repo(con, name: str) -> None:
    con.execute("DELETE FROM nodes WHERE repo = ?", (name,))
    con.execute("DELETE FROM edges WHERE repo = ?", (name,))
    con.execute("DELETE FROM imports WHERE repo = ?", (name,))
    con.execute("DELETE FROM files WHERE repo = ?", (name,))
    con.execute("DELETE FROM repos WHERE name = ?", (name,))
    con.commit()


def _drop_file(con, name: str, rel: str) -> None:
    """Remove all graph elements originating from one file."""
    con.execute("DELETE FROM nodes WHERE repo = ? AND file_path = ?", (name, rel))
    con.execute("DELETE FROM edges WHERE repo = ? AND src_file = ?", (name, rel))
    con.execute("DELETE FROM imports WHERE repo = ? AND file_path = ?", (name, rel))
    con.execute("DELETE FROM files WHERE repo = ? AND path = ?", (name, rel))


def _finalize(con, name: str, rel_path: str) -> tuple[int, int]:
    nodes = con.execute(
        "SELECT COUNT(*) FROM nodes WHERE repo = ?", (name,)
    ).fetchone()[0]
    edges = con.execute(
        "SELECT COUNT(*) FROM edges WHERE repo = ?", (name,)
    ).fetchone()[0]
    files = con.execute(
        "SELECT COUNT(*) FROM files WHERE repo = ?", (name,)
    ).fetchone()[0]
    con.execute(
        "INSERT INTO repos(name,path,indexed_at,node_count,edge_count,file_count) "
        "VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET path=excluded.path, "
        "indexed_at=excluded.indexed_at, node_count=excluded.node_count, "
        "edge_count=excluded.edge_count, file_count=excluded.file_count",
        (name, rel_path, datetime.now(timezone.utc).isoformat(timespec="seconds"),
         nodes, edges, files),
    )
    con.commit()
    return nodes, edges
