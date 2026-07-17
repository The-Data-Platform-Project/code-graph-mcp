"""Incremental reindex: content-hash change detection, additions, deletions."""

from __future__ import annotations

from code_graph import db, queries
from code_graph.indexer import Indexer


def _counts(config):
    con = db.connect(config.db_path)
    try:
        return queries.list_repositories(con)[0]
    finally:
        con.close()


def test_reindex_no_change_is_noop(indexed):
    before = _counts(indexed)
    root = indexed.workspaces_root / "sample"
    result = Indexer(indexed).reindex("sample", root, "sample")
    assert result.files_indexed == 0
    assert result.files_deleted == 0
    after = _counts(indexed)
    assert after["node_count"] == before["node_count"]
    assert after["edge_count"] == before["edge_count"]


def test_reindex_picks_up_new_file(indexed):
    root = indexed.workspaces_root / "sample"
    (root / "extra.py").write_text(
        "from pkg.utils import helper\n\n\ndef extra():\n    return helper(9)\n",
        encoding="utf-8",
    )
    result = Indexer(indexed).reindex("sample", root, "sample")
    assert result.files_indexed == 1

    con = db.connect(indexed.db_path)
    try:
        hits = {h["qualified_name"] for h in queries.search_symbol(con, "extra")}
        assert "extra.extra" in hits
        # new caller resolves to helper
        callers = {c["qualified_name"] for c in queries.get_callers(con, "pkg.utils.helper")}
        assert "extra.extra" in callers
    finally:
        con.close()


def test_reindex_detects_deletion(indexed):
    root = indexed.workspaces_root / "sample"
    (root / "app.py").unlink()
    result = Indexer(indexed).reindex("sample", root, "sample")
    assert result.files_deleted == 1

    con = db.connect(indexed.db_path)
    try:
        assert queries.search_symbol(con, "orphan") == []
        # app.py's rows are gone
        remaining = con.execute(
            "SELECT COUNT(*) FROM nodes WHERE repo='sample' AND file_path='app.py'"
        ).fetchone()[0]
        assert remaining == 0
    finally:
        con.close()


def test_reindex_reflects_content_change(indexed):
    root = indexed.workspaces_root / "sample"
    # Rewrite utils.helper's body — signature/lines change, node must update.
    (root / "pkg" / "utils.py").write_text(
        "def helper(x, y):\n    return x + y\n",
        encoding="utf-8",
    )
    result = Indexer(indexed).reindex("sample", root, "sample")
    assert result.files_indexed == 1

    con = db.connect(indexed.db_path)
    try:
        node = queries.find_node(con, "pkg.utils.helper")
        assert "y" in node["signature"]
        # Base was removed from utils.py, so Widget's INHERITS is now unresolved.
        row = conn_inherits(con)
        assert row["resolved"] == 0
    finally:
        con.close()


def conn_inherits(con):
    return con.execute(
        "SELECT resolved FROM edges "
        "WHERE edge_type='INHERITS' AND src_qname='pkg.core.Widget'"
    ).fetchone()
