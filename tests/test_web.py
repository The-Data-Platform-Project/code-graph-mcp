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
