"""Preview queries and the HTTP routes the visualizer calls.

The routes are mounted on a bare Starlette app here rather than on the FastMCP
one: `web.route_specs` is deliberately app-agnostic, so these tests exercise the
same handlers the server registers without standing up the MCP transport.
"""

from __future__ import annotations

import pytest
from starlette.applications import Starlette
from starlette.routing import Route
from starlette.testclient import TestClient

from code_graph import db, graph_export, queries, web

_README = """\
# Sample

A **sample** repo with [a link](https://example.com).

- one
- two
"""


@pytest.fixture
def client(indexed):
    specs = web.route_specs(indexed, lambda: db.connect(indexed.database_url))
    app = Starlette(
        routes=[
            Route(s.path, s.endpoint, methods=s.methods, name=s.name) for s in specs
        ]
    )
    with TestClient(app) as c:
        yield c


# ── README ────────────────────────────────────────────────────────────────


def test_readme_found_and_read_from_disk(conn, indexed, sample_root):
    (sample_root / "README.md").write_text(_README, encoding="utf-8")
    result = queries.get_repo_readme(conn, indexed, "sample")
    assert result["found"] is True
    assert result["file_path"] == "README.md"
    assert result["format"] == ".md"
    assert "A **sample** repo" in result["content"]
    assert result["truncated"] is False


def test_readme_absent_is_reported_not_raised(conn, indexed):
    result = queries.get_repo_readme(conn, indexed, "sample")
    assert result["found"] is False
    assert "README" in result["error"]


def test_readme_prefers_markdown_over_plain_text(conn, indexed, sample_root):
    (sample_root / "README.txt").write_text("plain", encoding="utf-8")
    (sample_root / "README.md").write_text("# md", encoding="utf-8")
    assert queries.get_repo_readme(conn, indexed, "sample")["file_path"] == "README.md"


def test_readme_of_unknown_repo(conn, indexed):
    result = queries.get_repo_readme(conn, indexed, "nope")
    assert result["found"] is False
    assert "not indexed" in result["error"]


# ── File source ───────────────────────────────────────────────────────────


def test_file_source_returns_whole_file(conn, indexed):
    result = queries.get_file_source(conn, indexed, "sample", "pkg/core.py")
    assert result["found"] is True
    assert "class Widget(Base):" in result["content"]
    assert result["line_count"] > 5


def test_file_source_confines_to_the_repo(conn, indexed, sample_root):
    # A file one directory up: inside the workspaces mount, outside the repo.
    # The whole mount is the user's drive, so escaping the repo must fail even
    # though `safe_join` on the mount alone would allow it.
    (sample_root.parent / "outside.txt").write_text("secret", encoding="utf-8")
    result = queries.get_file_source(conn, indexed, "sample", "../outside.txt")
    assert result["found"] is False
    assert "secret" not in str(result)


def test_file_source_confines_across_sibling_repos(conn, indexed, sample_root):
    other = sample_root.parent / "other-repo"
    other.mkdir(exist_ok=True)
    (other / "private.env").write_text("TOKEN=shhh", encoding="utf-8")
    result = queries.get_file_source(conn, indexed, "sample", "../other-repo/private.env")
    assert result["found"] is False
    assert "shhh" not in str(result)


def test_file_source_rejects_absolute_escape(conn, indexed):
    result = queries.get_file_source(conn, indexed, "sample", "/etc/passwd")
    assert result["found"] is False


def test_file_source_refuses_binary(conn, indexed, sample_root):
    (sample_root / "blob.bin").write_bytes(b"\x89PNG\x00\x01\x02binary\x00")
    result = queries.get_file_source(conn, indexed, "sample", "blob.bin")
    assert result["found"] is False
    assert "binary" in result["error"]


def test_file_source_truncates_large_files(conn, indexed, sample_root, monkeypatch):
    monkeypatch.setattr(queries, "_MAX_SOURCE_BYTES", 200)
    (sample_root / "big.py").write_text("x = 1\n" * 500, encoding="utf-8")
    result = queries.get_file_source(conn, indexed, "sample", "big.py")
    assert result["found"] is True
    assert result["truncated"] is True
    assert len(result["content"]) <= 200
    assert not result["content"].endswith("x =")  # cut at a line boundary


def test_file_source_missing_file(conn, indexed):
    result = queries.get_file_source(conn, indexed, "sample", "pkg/ghost.py")
    assert result["found"] is False
    assert "not found" in result["error"]


# ── Node context ──────────────────────────────────────────────────────────


def test_node_context_for_a_function(conn, indexed):
    ctx = queries.get_node_context(conn, indexed, "pkg.core.build")
    assert ctx["found"] is True
    assert ctx["node"]["kind"] == "Function"
    assert ctx["node"]["file_path"] == "pkg/core.py"

    # Its own source is there, and the whole file it lives in.
    assert ctx["source"]["found"] is True
    assert "def build(n):" in ctx["source"]["content"]

    # Connected functions: app.main calls build; build calls Widget and run.
    assert "app.main" in {c["qualified_name"] for c in ctx["callers"]}
    assert {"pkg.core.Widget", "pkg.core.Widget.run"} <= {
        c["callee"] for c in ctx["callees"] if c["resolved"]
    }
    # Connected files: core.py imports the symbols it uses from utils, and
    # app.py imports core.
    assert {"pkg.utils.helper", "pkg.utils.Base"} <= {
        d["target"] for d in ctx["dependencies"]
    }
    assert "app.py" in {d["file_path"] for d in ctx["dependents"]}
    # Siblings exclude the node itself.
    siblings = {s["qualified_name"] for s in ctx["siblings"]}
    assert "pkg.core.Widget" in siblings
    assert "pkg.core.build" not in siblings


def test_node_context_for_a_file(conn, indexed):
    ctx = queries.get_node_context(conn, indexed, "pkg.core")
    assert ctx["found"] is True
    assert ctx["node"]["kind"] == "File"
    assert "from .utils import" in ctx["source"]["content"]
    assert {"pkg.core.Widget", "pkg.core.build"} <= {
        s["qualified_name"] for s in ctx["siblings"]
    }


def test_node_context_keeps_unresolved_calls_honest(conn, indexed):
    ctx = queries.get_node_context(conn, indexed, "app.orphan")
    unresolved = [c for c in ctx["callees"] if not c["resolved"]]
    assert "does_not_exist" in {c["callee"] for c in unresolved}


def test_node_context_unknown_symbol(conn, indexed):
    ctx = queries.get_node_context(conn, indexed, "nope.nothing")
    assert ctx["found"] is False


def test_dependents_match_through_the_imported_symbol(conn):
    # app.py does `from pkg.core import build, Widget`, so the import edges
    # point at the symbols, not at the module — pkg/core.py is still the
    # file being depended on.
    deps = queries.get_dependents(conn, "sample", "pkg/core.py")
    assert "app.py" in {d["file_path"] for d in deps}
    assert {"pkg.core.build", "pkg.core.Widget"} & {d["imported"] for d in deps}


def test_dependents_exclude_the_file_itself(conn):
    deps = queries.get_dependents(conn, "sample", "pkg/utils.py")
    assert "pkg/utils.py" not in {d["file_path"] for d in deps}
    assert "pkg/core.py" in {d["file_path"] for d in deps}


# ── Graph payload ─────────────────────────────────────────────────────────


def test_graph_payload_shape(conn):
    payload = graph_export.build_payload(conn)
    assert payload["stats"]["nodes"] == len(payload["nodes"])
    assert {"name", "path", "node_count"} <= set(payload["repos"][0])
    node = next(n for n in payload["nodes"] if n["id"] == "pkg.core.build")
    assert node["kind"] == "Function" and node["end_line"] >= node["start_line"]
    ids = {n["id"] for n in payload["nodes"]}
    # Every link must connect two nodes actually present in the payload.
    assert all(link["source"] in ids and link["target"] in ids for link in payload["links"])


def test_graph_payload_respects_the_per_repo_cap(conn):
    payload = graph_export.build_payload(conn, max_nodes_per_repo=2)
    assert len(payload["nodes"]) == 2


# ── HTTP routes ───────────────────────────────────────────────────────────


def test_route_graph(client):
    body = client.get("/api/graph").json()
    assert body["stats"]["nodes"] > 0
    assert any(n["id"] == "pkg.core.build" for n in body["nodes"])


def test_route_readme(client, sample_root):
    assert client.get("/api/readme?repo=sample").status_code == 404
    (sample_root / "README.md").write_text(_README, encoding="utf-8")
    body = client.get("/api/readme?repo=sample").json()
    assert body["found"] is True and body["file_path"] == "README.md"


def test_route_readme_requires_repo(client):
    assert client.get("/api/readme").status_code == 400


def test_route_node(client):
    body = client.get("/api/node?repo=sample&qname=pkg.core.build").json()
    assert body["found"] is True
    assert body["node"]["name"] == "build"
    assert body["source"]["found"] is True

    missing = client.get("/api/node?repo=sample&qname=nope")
    assert missing.status_code == 404 and missing.json()["found"] is False
    assert client.get("/api/node").status_code == 400


def test_route_file(client):
    body = client.get("/api/file?repo=sample&path=pkg/utils.py").json()
    assert body["found"] is True and "def helper(x):" in body["content"]
    assert client.get("/api/file?repo=sample").status_code == 400
    assert client.get("/api/file?repo=sample&path=../../etc/passwd").status_code == 404


def test_route_index_serves_the_visualizer(client, indexed, tmp_path, monkeypatch):
    # Points at the checked-in page by default; here we assert the wiring.
    missing = client.get("/")
    assert missing.status_code in (200, 404)
    page = tmp_path / "viz"
    page.mkdir()
    (page / "index.html").write_text("<!DOCTYPE html><title>Code Graph</title>", "utf-8")
    specs = web.route_specs(
        type(indexed)(**{**indexed.__dict__, "visualizer_dir": page}),
        lambda: db.connect(indexed.database_url),
    )
    app = Starlette(routes=[Route(s.path, s.endpoint, methods=s.methods) for s in specs])
    with TestClient(app) as c:
        res = c.get("/")
        assert res.status_code == 200
        assert "Code Graph" in res.text


def test_routes_send_no_cors_headers(client):
    # Same-origin by design: no other page the browser visits may read these.
    res = client.get("/api/graph")
    assert "access-control-allow-origin" not in {k.lower() for k in res.headers}


# ── Token gate ────────────────────────────────────────────────────────────
# The service is published through a tunnel so the Vercel app can reach it,
# which makes this the boundary between "my machine" and the internet.


def _gated_client(config, token):
    specs = web.route_specs(config, lambda: db.connect(config.database_url))
    app = Starlette(
        routes=[Route(s.path, s.endpoint, methods=s.methods) for s in specs]
    )
    return TestClient(web.TokenAuthMiddleware(app, token=token))


def test_healthz_needs_no_token(indexed):
    with _gated_client(indexed, "sekrit") as client:
        res = client.get("/healthz")
        assert res.status_code == 200
        # It must not leak anything about the graph or the repos.
        assert res.json() == {"status": "ok"}


def test_requests_without_a_token_are_refused(indexed):
    with _gated_client(indexed, "sekrit") as client:
        for path in ("/", "/api/graph", "/api/node?repo=sample&qname=pkg.core.build"):
            res = client.get(path)
            assert res.status_code == 401, path
            assert res.headers["www-authenticate"] == "Bearer"


def test_a_wrong_token_is_refused(indexed):
    with _gated_client(indexed, "sekrit") as client:
        assert (
            client.get(
                "/api/graph", headers={"Authorization": "Bearer wrong"}
            ).status_code
            == 401
        )
        # A correct prefix must not pass either.
        assert (
            client.get(
                "/api/graph", headers={"Authorization": "Bearer sek"}
            ).status_code
            == 401
        )


def test_the_right_token_passes_either_header(indexed):
    with _gated_client(indexed, "sekrit") as client:
        assert (
            client.get(
                "/api/graph", headers={"Authorization": "Bearer sekrit"}
            ).status_code
            == 200
        )
        assert (
            client.get(
                "/api/graph", headers={"X-Code-Graph-Token": "sekrit"}
            ).status_code
            == 200
        )


def test_an_empty_token_leaves_the_service_open(indexed):
    # Supported for a purely local run; compose refuses to start without a
    # token precisely because this mode must never meet the tunnel.
    with _gated_client(indexed, "") as client:
        assert client.get("/api/graph").status_code == 200
