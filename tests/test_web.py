"""HTML/CSS dependency extraction and resolution to code/asset file nodes."""

from __future__ import annotations

from code_graph import queries

_INDEX_HTML = """\
<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="site.css">
    <script src="js/app.js"></script>
    <script src="https://cdn.example.com/lib.js"></script>
  </head>
  <body><a href="about.html">about</a></body>
</html>
"""

_SITE_CSS = """\
@import "base.css";
@import url("theme.css");
body { color: red; }
"""

REPO = {
    "index.html": _INDEX_HTML,
    "site.css": _SITE_CSS,
    "base.css": "body { margin: 0; }\n",
    "theme.css": ":root { --c: blue; }\n",
    "js/app.js": "export function main() { return 1; }\n",
}


def test_html_links_resolve_to_js_and_css(make_repo):
    con, _ = make_repo(REPO)
    deps = {d["target"]: d for d in queries.get_dependencies(con, "index.html")}
    # <script src="js/app.js"> -> the JS *module* node (dotted)
    assert deps["js.app"]["in_project"] is True
    # <link href="site.css"> -> the CSS *file* node (path-with-ext)
    assert deps["site.css"]["in_project"] is True
    # external CDN script recorded but not in-project
    assert deps["https://cdn.example.com/lib.js"]["in_project"] is False
    # a link to a non-existent page is recorded but stays unresolved
    assert deps["about.html"]["in_project"] is False


def test_css_import_resolves_between_stylesheets(make_repo):
    con, _ = make_repo(REPO)
    targets = {d["target"] for d in queries.get_dependencies(con, "site.css")}
    assert "base.css" in targets
    assert "theme.css" in targets  # @import url("...") form
    imports = queries.get_dependencies(con, "site.css")
    assert all(
        d["in_project"] for d in imports if d["target"] in {"base.css", "theme.css"}
    )


def test_html_file_node_present(make_repo):
    con, _ = make_repo(REPO)
    row = con.execute(
        "SELECT kind FROM nodes WHERE qualified_name = 'index.html'"
    ).fetchone()
    assert row is not None and row["kind"] == "File"


# Absolute asset refs (`/static/...`) served from a subdirectory: the web
# doc-root is not the repo root, so the exact-root candidate misses. A unique
# trailing-path match recovers the real file node.
_ROOTED_REPO = {
    "webapp/app/templates/base.html": (
        '<link rel="stylesheet" href="/static/site.css">\n'
        '<script src="/static/app.js"></script>\n'
        '<script src="/static/js/util.js"></script>\n'
    ),
    "webapp/app/static/site.css": "body { color: red; }\n",
    "webapp/app/static/app.js": "export function main() { return 1; }\n",
    "webapp/app/static/js/util.js": "export function u() { return 2; }\n",
}


def test_absolute_static_ref_resolves_to_nested_file(make_repo):
    con, _ = make_repo(_ROOTED_REPO)
    deps = {
        d["local_name"]: d
        for d in queries.get_dependencies(con, "webapp/app/templates/base.html")
    }
    # /static/app.js -> the JS module node under webapp/app/static
    assert deps["/static/app.js"]["target"] == "webapp.app.static.app"
    assert deps["/static/app.js"]["in_project"] is True
    # /static/site.css -> the CSS file node (path-with-ext qname)
    assert deps["/static/site.css"]["target"] == "webapp/app/static/site.css"
    assert deps["/static/site.css"]["in_project"] is True
    # a deeper rooted path (multi-segment suffix) resolves too
    assert deps["/static/js/util.js"]["target"] == "webapp.app.static.js.util"
    assert deps["/static/js/util.js"]["in_project"] is True


def test_absolute_static_ref_edge_connects(make_repo):
    con, _ = make_repo(_ROOTED_REPO)
    # the IMPORTS edge now points at the real node and is marked resolved
    row = con.execute(
        "SELECT dst_qname, resolved FROM edges "
        "WHERE edge_type='IMPORTS' AND src_file='webapp/app/templates/base.html' "
        "AND dst_raw='/static/app.js'"
    ).fetchone()
    assert row["dst_qname"] == "webapp.app.static.app"
    assert row["resolved"] == 1


# Two files share the same trailing path: the ref is ambiguous, so it must be
# left honestly unresolved rather than linked to an arbitrary one.
_AMBIG_REPO = {
    "a/index.html": '<script src="/static/x.js"></script>\n',
    "one/static/x.js": "export function f() {}\n",
    "two/static/x.js": "export function g() {}\n",
}


def test_ambiguous_absolute_ref_stays_unresolved(make_repo):
    con, _ = make_repo(_AMBIG_REPO)
    deps = {d["local_name"]: d for d in queries.get_dependencies(con, "a/index.html")}
    assert deps["/static/x.js"]["in_project"] is False


def test_absent_absolute_ref_stays_unresolved(make_repo):
    con, _ = make_repo({"a/index.html": '<script src="/static/missing.js"></script>\n'})
    deps = {d["local_name"]: d for d in queries.get_dependencies(con, "a/index.html")}
    assert deps["/static/missing.js"]["in_project"] is False
