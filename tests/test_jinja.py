"""Jinja template extraction: inheritance/includes, macro defs, and macro uses."""

from __future__ import annotations

from code_graph import queries

_BASE = "<!doctype html><html><body>{% block body %}{% endblock %}</body></html>\n"

_MACROS = (
    "{% macro password_field(name, value='') %}\n"
    '  <input type="password" name="{{ name }}" value="{{ value }}">\n'
    "{% endmacro %}\n"
    '{% macro text_field(name) %}<input name="{{ name }}">{% endmacro %}\n'
)

# Nested template: refs are template-root-relative, not dir-relative.
_LOGIN = (
    '{% extends "base.html" %}\n'
    '{% from "macros.html" import password_field %}\n'
    "{% block body %}\n"
    "  <form>{{ password_field('pw') }}</form>\n"
    "  <a href=\"{{ url_for('home') }}\">home</a>\n"
    "{% endblock %}\n"
)

# Uses the macro through an aliased whole-module import.
_SIGNUP = (
    '{% extends "base.html" %}\n'
    '{% import "macros.html" as m %}\n'
    "{% block body %}{{ m.password_field('pw2') }}{% endblock %}\n"
)

REPO = {
    "templates/base.html": _BASE,
    "templates/macros.html": _MACROS,
    "templates/forms/login.html": _LOGIN,
    "templates/forms/signup.html": _SIGNUP,
}


def _nodes(con):
    return {
        (r["kind"], r["qualified_name"])
        for r in con.execute("SELECT kind, qualified_name FROM nodes")
    }


def test_macro_definitions_become_nodes(make_repo):
    con, _ = make_repo(REPO)
    nodes = _nodes(con)
    assert ("Function", "templates/macros.html.password_field") in nodes
    assert ("Function", "templates/macros.html.text_field") in nodes


def test_search_symbol_finds_macro(make_repo):
    con, _ = make_repo(REPO)
    hits = {h["qualified_name"] for h in queries.search_symbol(con, "password_field")}
    assert "templates/macros.html.password_field" in hits


def test_which_templates_use_the_macro(make_repo):
    con, _ = make_repo(REPO)
    users = {
        c["qualified_name"]
        for c in queries.get_callers(con, "templates/macros.html.password_field")
    }
    # both the `from import` user and the aliased `import ... as m` user
    assert "templates/forms/login.html" in users
    assert "templates/forms/signup.html" in users


def test_extends_and_import_resolve_to_template_root(make_repo):
    con, _ = make_repo(REPO)
    deps = {
        d["target"]: d
        for d in queries.get_dependencies(con, "templates/forms/login.html")
    }
    # {% extends "base.html" %} -> the real template at the root, not forms/base.html
    assert deps["templates/base.html"]["in_project"] is True
    # {% from "macros.html" import ... %} -> the macros template
    assert deps["templates/macros.html"]["in_project"] is True


def test_template_globals_do_not_create_call_noise(make_repo):
    con, _ = make_repo(REPO)
    # url_for(...) is a template global, not a known macro binding -> no CALLS edge
    row = con.execute(
        "SELECT COUNT(*) AS n FROM edges WHERE edge_type='CALLS' AND dst_raw='url_for'"
    ).fetchone()
    assert row["n"] == 0
