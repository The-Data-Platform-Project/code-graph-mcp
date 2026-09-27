"""Indexing pipeline.

Memory discipline (the load-bearing part of this project):
- Files are discovered with an `os.walk` generator; the full list is never
  materialized.
- Each file is parsed, extracted, its rows buffered, and its parse tree dropped
  before the next file is read. No tree is ever held across files.
- Rows are flushed to Postgres every `commit_batch_files` files, so pending
  state is bounded to a couple hundred files' worth of small tuples, not the
  repo.
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
from .languages import extractor_for, parser_for, spec_for
from .models import FileResult

# Directories never worth walking into (dot-directories are pruned separately).
_PRUNE_DIRS = frozenset(
    {
        "__pycache__", "node_modules", "venv", "env",
        "dist", "build", ".eggs", "site-packages", ".hg", ".svn",
        "coverage", "bower_components", "vendor", "target",
    }
)


# Write statements, kept in one place since the batch flush and the
# single-file reindex path both use them.
_INSERT_NODE = (
    "INSERT INTO nodes(repo,kind,name,qualified_name,file_path,"
    "start_line,end_line,signature) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)"
)
_INSERT_EDGE = (
    "INSERT INTO edges(repo,edge_type,src_qname,dst_qname,dst_raw,"
    "src_file,resolved) VALUES(%s,%s,%s,%s,%s,%s,%s)"
)
_UPSERT_IMPORT = (
    "INSERT INTO imports(repo,file_path,local_name,target,kind) "
    "VALUES(%s,%s,%s,%s,%s) "
    "ON CONFLICT (repo,file_path,local_name) DO UPDATE SET "
    "target=EXCLUDED.target, kind=EXCLUDED.kind"
)
_UPSERT_FILE = (
    "INSERT INTO files(repo,path,hash) VALUES(%s,%s,%s) "
    "ON CONFLICT (repo,path) DO UPDATE SET hash=EXCLUDED.hash"
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
        con = db.connect(self._config.database_url)
        try:
            _clear_repo(con, name)
            files_indexed, files_skipped = self._ingest(con, name, abs_root)
            resolver.resolve_repo(con, self._config.database_url, name)
            nodes, edges = _finalize(con, name, rel_path)
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
        con = db.connect(self._config.database_url)
        try:
            known = {
                row["path"]: row["hash"]
                for row in con.execute(
                    "SELECT path, hash FROM files WHERE repo = %s", (name,)
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
            resolver.resolve_repo(con, self._config.database_url, name)
            nodes, edges = _finalize(con, name, rel_path)
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
            with con.cursor() as cur:
                if node_buf:
                    cur.executemany(_INSERT_NODE, node_buf)
                    node_buf.clear()
                if edge_buf:
                    cur.executemany(_INSERT_EDGE, edge_buf)
                    edge_buf.clear()
                if import_buf:
                    cur.executemany(_UPSERT_IMPORT, import_buf)
                    import_buf.clear()
                if file_buf:
                    cur.executemany(_UPSERT_FILE, file_buf)
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
        with con.cursor() as cur:
            cur.executemany(_INSERT_NODE, node_buf)
            cur.executemany(_INSERT_EDGE, edge_buf)
            if import_buf:
                cur.executemany(_UPSERT_IMPORT, import_buf)
            cur.executemany(_UPSERT_FILE, file_buf)


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
            if spec_for(fn) is None:
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
    spec = spec_for(rel)
    if spec is None:
        return None
    extractor = extractor_for(spec)
    if spec.grammar_module is None:
        # Grammar-less extractor (generic config / JSON): no parse tree.
        return _safe_extract(extractor, None, data, rel)
    parser = parser_for(spec)
    if parser is None:
        # Declared grammar could not be loaded: skip the file, don't abort.
        return None
    tree = parser.parse(data)
    try:
        return _safe_extract(extractor, tree, data, rel)
    finally:
        # Drop the tree explicitly before the next file is touched.
        del tree


def _safe_extract(extractor, tree, data: bytes, rel: str) -> FileResult | None:
    """Run an extractor, skipping (not crashing) on a per-file extraction error.

    A single malformed or pathological file must never abort a whole-repo index
    of a standing service.
    """
    try:
        return extractor.extract(tree, data, rel)
    except Exception:
        return None


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
    con.execute("DELETE FROM nodes WHERE repo = %s", (name,))
    con.execute("DELETE FROM edges WHERE repo = %s", (name,))
    con.execute("DELETE FROM imports WHERE repo = %s", (name,))
    con.execute("DELETE FROM files WHERE repo = %s", (name,))
    con.execute("DELETE FROM repos WHERE name = %s", (name,))
    con.commit()


def _drop_file(con, name: str, rel: str) -> None:
    """Remove all graph elements originating from one file."""
    con.execute("DELETE FROM nodes WHERE repo = %s AND file_path = %s", (name, rel))
    con.execute("DELETE FROM edges WHERE repo = %s AND src_file = %s", (name, rel))
    con.execute("DELETE FROM imports WHERE repo = %s AND file_path = %s", (name, rel))
    con.execute("DELETE FROM files WHERE repo = %s AND path = %s", (name, rel))


def _finalize(con, name: str, rel_path: str) -> tuple[int, int]:
    # Rows come back as dicts, so the counts are aliased rather than positional.
    def _count(table: str, column: str) -> int:
        return con.execute(
            f"SELECT COUNT(*) AS n FROM {table} WHERE {column} = %s", (name,)
        ).fetchone()["n"]

    nodes = _count("nodes", "repo")
    edges = _count("edges", "repo")
    files = _count("files", "repo")
    con.execute(
        "INSERT INTO repos(name,path,indexed_at,node_count,edge_count,file_count) "
        "VALUES(%s,%s,%s,%s,%s,%s) "
        "ON CONFLICT(name) DO UPDATE SET path=EXCLUDED.path, "
        "indexed_at=EXCLUDED.indexed_at, node_count=EXCLUDED.node_count, "
        "edge_count=EXCLUDED.edge_count, file_count=EXCLUDED.file_count",
        (name, rel_path, datetime.now(timezone.utc).isoformat(timespec="seconds"),
         nodes, edges, files),
    )
    con.commit()
    return nodes, edges
