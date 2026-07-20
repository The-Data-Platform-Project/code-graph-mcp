"""Data/config indexing: package.json deps, compose services, generic fallback."""

from __future__ import annotations

from code_graph import queries

_PACKAGE_JSON = """\
{
  "name": "demo",
  "dependencies": { "react": "^18.0.0", "lodash": "^4.17.0" },
  "devDependencies": { "jest": "^29.0.0" }
}
"""

_COMPOSE = """\
version: "3"
services:
  web:
    image: nginx
    depends_on:
      - db
      - cache
  db:
    image: postgres
  cache:
    image: redis
"""

REPO = {
    "package.json": _PACKAGE_JSON,
    "docker-compose.yml": _COMPOSE,
    "Dockerfile": "FROM python:3.11-slim\nRUN pip install app\n",
    "config.ini": "[server]\nport = 8080\n",
    "settings.toml": "[tool]\nname = 'demo'\n",
}


def test_package_json_lists_npm_dependencies(make_repo):
    con, _ = make_repo(REPO)
    deps = {d["target"]: d for d in queries.get_dependencies(con, "package.json")}
    for pkg in ("react", "lodash", "jest"):
        assert pkg in deps
        assert deps[pkg]["kind"] == "external"
        assert deps[pkg]["in_project"] is False


def test_compose_services_and_depends_on(make_repo):
    con, _ = make_repo(REPO)
    services = {
        r["qualified_name"]
        for r in con.execute("SELECT qualified_name FROM nodes WHERE kind = 'Service'")
    }
    assert services == {
        "docker-compose.yml::web",
        "docker-compose.yml::db",
        "docker-compose.yml::cache",
    }
    # web depends_on db and cache -> resolved service->service edges
    dep_targets = {
        r["dst_qname"]
        for r in con.execute(
            "SELECT dst_qname FROM edges WHERE edge_type = 'IMPORTS' "
            "AND src_qname = 'docker-compose.yml::web' AND resolved = 1"
        )
    }
    assert dep_targets == {"docker-compose.yml::db", "docker-compose.yml::cache"}


def test_generic_fallback_indexes_config_files(make_repo):
    con, _ = make_repo(REPO)
    configs = {
        r["qualified_name"]
        for r in con.execute("SELECT qualified_name FROM nodes WHERE kind = 'Config'")
    }
    # Dockerfile (by name), .ini/.toml (by extension), and .json all present.
    assert {"Dockerfile", "config.ini", "settings.toml", "package.json"} <= configs


def test_config_files_and_services_are_searchable(make_repo):
    con, _ = make_repo(REPO)
    assert any(
        r["qualified_name"] == "config.ini"
        for r in queries.search_symbol(con, "config.ini")
    )
    assert any(
        r["kind"] == "Service" and r["name"] == "web"
        for r in queries.search_symbol(con, "web")
    )
