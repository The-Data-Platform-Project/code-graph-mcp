"""JavaScript / TypeScript extraction and cross-file resolution."""

from __future__ import annotations

from code_graph import queries

_UTILS_JS = """\
export function helper(x) { return x + 1; }

export class Base {
  greet() { return "hi"; }
}
"""

_APP_JS = """\
import { helper, Base } from './utils';
import React from 'react';

class Widget extends Base {
  run() { return helper(this.value); }
  greet_twice() { return this.greet() + this.greet(); }
}

function build(n) {
  const w = new Widget();
  return helper(n);
}

const make = () => build(3);
"""

_TYPES_TS = """\
import { Base } from './pkg/utils';

interface Runnable { run(): number; }

export class Engine extends Base implements Runnable {
  run(): number { return 1; }
}
"""

REPO = {
    "pkg/utils.js": _UTILS_JS,
    "pkg/app.js": _APP_JS,
    "types.ts": _TYPES_TS,
}


def _nodes(con):
    return {
        (r["kind"], r["qualified_name"])
        for r in con.execute("SELECT kind, qualified_name FROM nodes")
    }


def test_js_symbols_and_dotted_qnames(make_repo):
    con, _ = make_repo(REPO)
    nodes = _nodes(con)
    assert ("File", "pkg.utils") in nodes
    assert ("Function", "pkg.utils.helper") in nodes
    assert ("Class", "pkg.utils.Base") in nodes
    assert ("Method", "pkg.utils.Base.greet") in nodes
    assert ("Class", "pkg.app.Widget") in nodes
    assert ("Method", "pkg.app.Widget.run") in nodes
    assert ("Function", "pkg.app.build") in nodes
    # arrow function bound to a const is a Function node
    assert ("Function", "pkg.app.make") in nodes


def test_js_cross_file_call_resolution(make_repo):
    con, _ = make_repo(REPO)
    # import-map: helper() inside app.js resolves to the real utils.js function
    callers = {c["qualified_name"] for c in queries.get_callers(con, "pkg.utils.helper")}
    assert "pkg.app.build" in callers
    assert "pkg.app.Widget.run" in callers
    # same-module: make() -> build()
    assert "pkg.app.make" in {
        c["qualified_name"] for c in queries.get_callers(con, "pkg.app.build")
    }


def test_js_this_call_resolves_to_inherited_method(make_repo):
    con, _ = make_repo(REPO)
    # `this.greet()` in Widget resolves through the enclosing class to the
    # inherited Base.greet (self/cls/this handling + unique-name fallback).
    callees = {
        c["callee"] for c in queries.get_callees(con, "pkg.app.Widget.greet_twice")
        if c["resolved"]
    }
    assert "pkg.utils.Base.greet" in callees


def test_js_inherits_and_ts_implements(make_repo):
    con, _ = make_repo(REPO)
    edges = {
        (r["edge_type"], r["src_qname"], r["dst_qname"])
        for r in con.execute(
            "SELECT edge_type, src_qname, dst_qname FROM edges WHERE resolved = 1"
        )
    }
    assert ("INHERITS", "pkg.app.Widget", "pkg.utils.Base") in edges
    assert ("INHERITS", "types.Engine", "pkg.utils.Base") in edges
    assert ("IMPLEMENTS", "types.Engine", "types.Runnable") in edges
    assert ("Interface", "types.Runnable") in _nodes(con)


def test_js_dependencies_external_vs_in_project(make_repo):
    con, _ = make_repo(REPO)
    deps = {d["target"]: d for d in queries.get_dependencies(con, "pkg/app.js")}
    assert deps["pkg.utils.helper"]["in_project"] is True
    assert deps["react"]["in_project"] is False
    assert deps["react"]["kind"] == "external"


# IIFE-wrapped module (the classic browser-script pattern): every declaration
# lives inside an anonymous function, one or more levels below top level.
_IIFE_JS = """\
(function () {
  function gridOf(el) { return el.closest('x'); }

  function toggleSort(th) { return gridOf(th); }

  const helper = () => gridOf(null);

  function outer() {
    function inner() { return toggleSort(1); }
    return inner();
  }

  window.Grid = { toggleSort: toggleSort, outer: outer };
})();
"""

IIFE_REPO = {"static/grid.js": _IIFE_JS}


def test_js_iife_wrapped_module_yields_symbols(make_repo):
    con, _ = make_repo(IIFE_REPO)
    nodes = _nodes(con)
    # functions declared inside the IIFE attribute to the module qname
    assert ("Function", "static.grid.gridOf") in nodes
    assert ("Function", "static.grid.toggleSort") in nodes
    assert ("Function", "static.grid.helper") in nodes  # arrow const inside the IIFE
    assert ("Function", "static.grid.outer") in nodes
    # nesting is followed one more level down
    assert ("Function", "static.grid.outer.inner") in nodes


def test_js_iife_internal_calls_resolve(make_repo):
    con, _ = make_repo(IIFE_REPO)
    # toggleSort() and helper() both call gridOf(), a same-module sibling
    callers = {c["qualified_name"] for c in queries.get_callers(con, "static.grid.gridOf")}
    assert "static.grid.toggleSort" in callers
    assert "static.grid.helper" in callers
    # nested inner() calls toggleSort()
    assert "static.grid.outer.inner" in {
        c["qualified_name"] for c in queries.get_callers(con, "static.grid.toggleSort")
    }
