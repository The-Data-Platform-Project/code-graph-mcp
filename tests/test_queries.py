"""Integration tests: index the sample repo, then exercise every query + resolution."""

from __future__ import annotations

from code_graph import queries


def test_list_repositories(conn):
    repos = queries.list_repositories(conn)
    assert len(repos) == 1
    r = repos[0]
    assert r["name"] == "sample"
    assert r["file_count"] == 4  # __init__, utils, core, app
    assert r["node_count"] > 0 and r["edge_count"] > 0


def test_search_symbol_substring(conn):
    hits = {h["qualified_name"] for h in queries.search_symbol(conn, "run")}
    assert "pkg.core.Widget.run" in hits


def test_search_symbol_wildcard(conn):
    hits = {h["qualified_name"] for h in queries.search_symbol(conn, "gr*")}
    assert "pkg.utils.Base.greet" in hits
    assert "pkg.core.Widget.greet_twice" in hits


def test_import_map_resolution(conn):
    # Widget.run calls helper(), imported via `from .utils import helper`
    callees = {
        c["callee"]
        for c in queries.get_callees(conn, "pkg.core.Widget.run")
        if c["resolved"]
    }
    assert "pkg.utils.helper" in callees


def test_same_module_resolution(conn):
    # build() constructs Widget defined in the same module
    callees = {c["callee"] for c in queries.get_callees(conn, "pkg.core.build") if c["resolved"]}
    assert "pkg.core.Widget" in callees


def test_unique_name_resolves_inherited_method(conn):
    # greet_twice calls self.greet(); greet is inherited from Base and unique in repo
    callees = {
        c["callee"]
        for c in queries.get_callees(conn, "pkg.core.Widget.greet_twice")
        if c["resolved"]
    }
    assert "pkg.utils.Base.greet" in callees


def test_honest_unresolved(conn):
    # orphan() calls does_not_exist(), which is not in the project
    callees = queries.get_callees(conn, "app.orphan")
    unresolved = [c for c in callees if not c["resolved"]]
    assert any(c["callee"] == "does_not_exist" for c in unresolved)


def test_get_callers(conn):
    # helper() is called directly only by Widget.run (build calls it transitively)
    callers = {c["qualified_name"] for c in queries.get_callers(conn, "pkg.utils.helper")}
    assert callers == {"pkg.core.Widget.run"}


def test_trace_call_path_callees(conn):
    trace = queries.trace_call_path(conn, "app.main", "callees", depth=4)
    # main -> build -> {helper, Widget, Widget.run -> helper}
    seen = set()

    def collect(node):
        seen.add(node["qualified_name"])
        for child in node.get("children", []):
            collect(child)

    collect(trace["tree"])
    assert "pkg.core.build" in seen
    assert "pkg.utils.helper" in seen


def test_trace_call_path_callers(conn):
    trace = queries.trace_call_path(conn, "pkg.utils.helper", "callers", depth=3)
    seen = set()

    def collect(node):
        seen.add(node["qualified_name"])
        for child in node.get("children", []):
            collect(child)

    collect(trace["tree"])
    assert "pkg.core.build" in seen


def test_get_dependencies(conn):
    deps = queries.get_dependencies(conn, "app.py")
    by_target = {d["target"]: d for d in deps}
    assert by_target["pkg.core.build"]["in_project"] is True
    assert by_target["pkg.core.Widget"]["in_project"] is True


def test_get_code_snippet_reads_disk(conn, indexed):
    snip = queries.get_code_snippet(conn, indexed, "pkg.core.Widget.run")
    assert snip["found"] is True
    assert "return helper(self.n)" in snip["code"]
    assert snip["kind"] == "Method"


def test_get_code_snippet_missing(conn, indexed):
    snip = queries.get_code_snippet(conn, indexed, "pkg.core.NoSuch")
    assert snip["found"] is False


def test_inherits_resolved(conn):
    # Widget inherits Base (imported) -> resolved edge in the graph
    row = conn.execute(
        "SELECT resolved, dst_qname FROM edges "
        "WHERE edge_type='INHERITS' AND src_qname='pkg.core.Widget'"
    ).fetchone()
    assert row["resolved"] == 1
    assert row["dst_qname"] == "pkg.utils.Base"


def test_no_source_text_stored(conn):
    # DB is structure-only: no column should be there to hold source text.
    columns = [
        f"{r['table_name']}.{r['column_name']}"
        for r in conn.execute(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema()"
        ).fetchall()
    ]
    assert columns, "expected the graph tables to exist"
    for column in columns:
        assert "source" not in column.lower()
        assert "content" not in column.lower()
        assert "body" not in column.lower()
