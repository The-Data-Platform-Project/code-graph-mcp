"""Fixtures for the platform tests: materialized fixture organizations.

Building the repositories costs a few git invocations, so it happens once per
session and every test shares the result. Tests must treat the trees as
read-only; a test that needs to mutate one should copy it first.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from . import fixture_repos  # noqa: E402


@pytest.fixture(scope="session")
def manifest() -> dict:
    return fixture_repos.load_manifest()


@pytest.fixture(scope="session")
def fixture_orgs(tmp_path_factory, manifest) -> dict[str, fixture_repos.FixtureRepo]:
    """Every fixture repository, materialized as a git repo, keyed by full name."""
    if not fixture_repos.git_available():
        pytest.skip("git is not available")
    dest = tmp_path_factory.mktemp("fixture-orgs")
    return fixture_repos.materialize(dest, manifest)


@pytest.fixture(scope="session")
def fixture_repo(fixture_orgs):
    """Look one fixture repository up by full name."""

    def _get(full_name: str) -> fixture_repos.FixtureRepo:
        try:
            return fixture_orgs[full_name]
        except KeyError:  # pragma: no cover - test authoring error
            raise AssertionError(
                f"unknown fixture repo {full_name!r}; have {sorted(fixture_orgs)}"
            ) from None

    return _get
