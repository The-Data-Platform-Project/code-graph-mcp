"""The fixture organizations are themselves under test.

Later phases assert things *about* these repositories (incremental ingestion,
lifecycle classification, cross-organization dependencies, secret redaction), so
the fixtures have to be correct before anything built on them means much.
"""

from __future__ import annotations

import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

from code_graph.config import Config
from code_graph.indexer import Indexer

from . import planted_secrets
from .fixture_repos import FIXTURE_ROOT, OVERSIZED_BYTES

ALL_REPOS = {
    "acme/shop-web",
    "acme/shop-api",
    "acme/shop-infra",
    "acme/common-lib",
    "globex/analytics",
    "globex/case-study-retail",
    "globex/old-prototype",
    "globex/mono",
    "sandbox/secrets-trap",
    "sandbox/broken",
}


def _git(repo_path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=str(repo_path), capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()


def _last_commit_at(repo_path: Path) -> datetime:
    return datetime.fromisoformat(_git(repo_path, "log", "-1", "--format=%cI"))


# --- shape ----------------------------------------------------------------
def test_every_manifest_repo_is_materialized(fixture_orgs):
    assert set(fixture_orgs) == ALL_REPOS


def test_repository_ids_are_unique(manifest):
    ids = [r["provider_repo_id"] for r in manifest["repositories"]]
    assert len(ids) == len(set(ids))


def test_duplicate_listing_shares_an_id(manifest):
    dupe = manifest["duplicate_listings"][0]
    by_id = {r["provider_repo_id"]: r["full_name"] for r in manifest["repositories"]}
    # Same GitHub id, different name: discovery must collapse them into one repo.
    assert by_id[dupe["provider_repo_id"]] == "acme/shop-api"
    assert dupe["full_name"] != "acme/shop-api"


def test_renamed_repo_keeps_its_id(manifest):
    renamed = next(
        r for r in manifest["repositories"] if r["full_name"] == "globex/old-prototype"
    )
    assert renamed["previous_full_name"] == "globex/prototype"
    assert renamed["provider_repo_id"] == 200003


# --- git history ----------------------------------------------------------
def test_commit_history_is_scripted(fixture_repo):
    repo = fixture_repo("acme/shop-api")
    log = _git(repo.path, "log", "--format=%s").splitlines()
    assert log == [
        "Ship deployment, CI and the published schema",
        "Capture payments and publish order events",
        "Order endpoints over Postgres",
    ]
    assert len(repo.commit_shas) == 3
    assert repo.head_sha == _git(repo.path, "rev-parse", "HEAD")


def test_default_branch_is_honoured(fixture_repo):
    assert _git(fixture_repo("acme/shop-api").path, "branch", "--show-current") == "main"
    assert (
        _git(fixture_repo("globex/old-prototype").path, "branch", "--show-current")
        == "master"
    )


def test_stale_repo_looks_stale(fixture_repo):
    stale = _last_commit_at(fixture_repo("globex/old-prototype").path)
    active = _last_commit_at(fixture_repo("acme/shop-api").path)
    now = datetime.now(timezone.utc)
    assert (now - stale).days > 365 * 2
    assert (now - active).days < 365
    assert fixture_repo("globex/old-prototype").metadata["is_archived"] is True


def test_history_supports_diffing_a_single_commit(fixture_repo):
    repo = fixture_repo("acme/shop-api")
    changed = _git(
        repo.path, "diff", "--name-only", repo.commit_shas[0], repo.commit_shas[1]
    ).splitlines()
    assert "app/payments.py" in changed
    assert "app/db.py" not in changed  # untouched by that commit


# --- generated repositories ----------------------------------------------
def test_secrets_trap_is_generated_not_committed(fixture_repo):
    repo = fixture_repo("sandbox/secrets-trap")
    config_py = (repo.path / "config.py").read_text(encoding="utf-8")
    assert planted_secrets.AWS_ACCESS_KEY_ID in config_py

    # ...and no planted value is committed anywhere in *this* repository.
    tracked = [p for p in FIXTURE_ROOT.rglob("*") if p.is_file()]
    haystack = "\n".join(
        p.read_text(encoding="utf-8", errors="replace") for p in tracked
    )
    for value in planted_secrets.values():
        assert value not in haystack


def test_oversized_file_exceeds_the_index_cap(fixture_repo):
    huge = fixture_repo("sandbox/broken").path / "huge.py"
    assert huge.stat().st_size > OVERSIZED_BYTES
    assert huge.stat().st_size > Config.from_env().max_file_bytes


# --- indexable by the existing analysis core ------------------------------
@pytest.mark.parametrize(
    "full_name, expect_symbol",
    [
        ("acme/shop-api", "app.main.create_order"),
        ("acme/shop-web", "src.api.fetchOrders"),
        ("globex/analytics", "analytics.etl.run"),
    ],
)
def test_fixture_repos_index_cleanly(tmp_path, fixture_repo, full_name, expect_symbol):
    from code_graph import db, queries

    repo = fixture_repo(full_name)
    config = Config(
        db_path=tmp_path / f"{repo.provider_repo_id}.db",
        workspaces_root=repo.path.parent,
        host="127.0.0.1",
        port=8765,
        max_file_bytes=1_500_000,
        commit_batch_files=200,
    )
    result = Indexer(config).index_full("fixture", repo.path, repo.path.name)
    assert result.files_indexed > 0
    assert result.nodes > 0

    con = db.connect(config.db_path)
    try:
        found = {n["qualified_name"] for n in queries.search_symbol(con, "*", limit=1000)}
        files = {
            row["qualified_name"]
            for row in con.execute(
                "SELECT qualified_name FROM nodes WHERE kind IN ('File', 'Config')"
            )
        }
    finally:
        con.close()
    assert expect_symbol in found | files


def test_broken_repo_skips_bad_files_but_indexes_good_ones(tmp_path, fixture_repo):
    from code_graph import db, queries

    repo = fixture_repo("sandbox/broken")
    config = Config(
        db_path=tmp_path / "broken.db",
        workspaces_root=repo.path.parent,
        host="127.0.0.1",
        port=8765,
        max_file_bytes=1_500_000,
        commit_batch_files=200,
    )
    result = Indexer(config).index_full("broken", repo.path, repo.path.name)
    # huge.py is over the cap; sample.zig has no grammar; bad.py does not parse.
    assert result.files_skipped >= 1
    con = db.connect(config.db_path)
    try:
        found = {n["qualified_name"] for n in queries.search_symbol(con, "fine")}
    finally:
        con.close()
    assert "ok.fine" in found
