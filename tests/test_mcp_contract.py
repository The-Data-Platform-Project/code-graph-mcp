"""Golden contract tests for the nine MCP tools.

These pin the *external* behaviour of the server: the exact JSON each tool
returns for a fixed fixture repository. Any change to the analysis core that
alters a tool's output fails here, so a downstream refactor (the platform
pipeline reusing the indexer, new extractor depth, ...) can never silently
change what Claude Code sees.

Regenerate deliberately, and review the diff:

    UPDATE_GOLDEN=1 pytest tests/test_mcp_contract.py
"""

from __future__ import annotations

import importlib
import json
import os
import shutil
from pathlib import Path

import pytest

FIXTURE = Path(__file__).parent / "fixtures" / "mcp_contract"
GOLDEN_DIR = Path(__file__).parent / "golden"
REPO = "contract"

# Fields that legitimately differ between runs and are replaced before comparison.
_VOLATILE = ("indexed_at",)


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    """The server module, reloaded against a throwaway DB and workspaces root."""
    tmp = tmp_path_factory.mktemp("contract")
    workspaces = tmp / "workspaces"
    shutil.copytree(FIXTURE, workspaces / REPO)
    os.environ["GRAPH_DB_PATH"] = str(tmp / "graph.db")
    os.environ["WORKSPACES_ROOT"] = str(workspaces)
    try:
        module = importlib.import_module("code_graph.server")
        module = importlib.reload(module)
        module.index_repository(REPO, REPO)
        yield module
    finally:
        os.environ.pop("GRAPH_DB_PATH", None)
        os.environ.pop("WORKSPACES_ROOT", None)


def _scrub(value):
    """Replace volatile values so goldens are stable across runs."""
    if isinstance(value, dict):
        return {
            k: "<volatile>" if k in _VOLATILE else _scrub(v) for k, v in value.items()
        }
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    return value


def check(name: str, actual) -> None:
    """Compare `actual` against the golden file `name`, or write it when updating."""
    path = GOLDEN_DIR / f"{name}.json"
    scrubbed = _scrub(actual)
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(scrubbed, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return
    assert path.is_file(), f"missing golden {path}; run with UPDATE_GOLDEN=1"
    expected = json.loads(path.read_text(encoding="utf-8"))
    assert scrubbed == expected, f"MCP output changed for {name}"


# --- the nine tools -------------------------------------------------------
def test_index_repository(server):
    # Re-indexing is idempotent: the same counts as the module-scoped first index.
    check("index_repository", server.index_repository(REPO, REPO))


def test_list_repositories(server):
    check("list_repositories", server.list_repositories())


def test_search_symbol_substring(server):
    check("search_symbol_substring", server.search_symbol("run"))


def test_search_symbol_wildcard(server):
    check("search_symbol_wildcard", server.search_symbol("gr*", repo=REPO))


def test_get_callers(server):
    check("get_callers", server.get_callers("pkg.utils.helper"))


def test_get_callees(server):
    check("get_callees", server.get_callees("pkg.core.Widget.run"))


def test_get_callees_unresolved(server):
    check("get_callees_unresolved", server.get_callees("app.orphan"))


def test_trace_call_path(server):
    check("trace_call_path", server.trace_call_path("app.main", "callees", depth=4))


def test_get_dependencies_python(server):
    check("get_dependencies_python", server.get_dependencies("app.py"))


def test_get_dependencies_template(server):
    check("get_dependencies_template", server.get_dependencies("web/templates/base.html"))


def test_get_code_snippet(server):
    check("get_code_snippet", server.get_code_snippet("pkg.core.Widget.run"))


def test_reindex_repository(server):
    check("reindex_repository", server.reindex_repository(REPO))


# --- error paths ----------------------------------------------------------
def test_invalid_repo_name(server):
    check("error_invalid_name", server.index_repository("bad name!", REPO))


def test_path_traversal_rejected(server):
    result = server.index_repository("escape", "../../etc")
    assert "error" in result


def test_unknown_repo_reindex(server):
    check("error_unknown_repo", server.reindex_repository("not-indexed"))


def test_missing_symbol_snippet(server):
    check("error_missing_symbol", server.get_code_snippet("pkg.core.NoSuch"))


def test_bad_direction(server):
    check("error_bad_direction", server.trace_call_path("app.main", "sideways"))
