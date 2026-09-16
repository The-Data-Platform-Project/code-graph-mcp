"""Materialize the fixture organizations into real git repositories.

`tests/fixtures/orgs/` holds working trees and a metadata manifest. The pipeline
needs *git* repositories: commit SHAs to pin snapshots to, history to diff, and
commit dates that make lifecycle classification (active vs. stale) meaningful.
This module turns the former into the latter in a temp directory, with fixed
authors and scripted commit dates so every run produces the same history shape.

Two repositories are generated rather than committed:
- `sandbox/secrets-trap`, whose planted credential shapes are assembled at build
  time (see `planted_secrets`) so no literal token is ever committed here.
- the oversized file in `sandbox/broken`, which would bloat the repository.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import planted_secrets

FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "fixtures" / "orgs"
MANIFEST_PATH = FIXTURE_ROOT / "manifest.json"

# Bigger than the default `max_file_bytes` (1.5 MB), so the indexer skips it.
OVERSIZED_BYTES = 2_000_000

_GIT_ENV = {
    "GIT_AUTHOR_NAME": "Fixture Author",
    "GIT_AUTHOR_EMAIL": "fixtures@example.invalid",
    "GIT_COMMITTER_NAME": "Fixture Author",
    "GIT_COMMITTER_EMAIL": "fixtures@example.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


@dataclass(frozen=True)
class FixtureRepo:
    """One materialized fixture repository."""

    full_name: str
    path: Path
    provider_repo_id: int
    default_branch: str
    metadata: dict
    commit_shas: tuple[str, ...] = field(default_factory=tuple)

    @property
    def head_sha(self) -> str:
        return self.commit_shas[-1]

    @property
    def org(self) -> str:
        return self.full_name.split("/", 1)[0]


def git_available() -> bool:
    try:
        subprocess.run(
            ["git", "--version"], check=True, capture_output=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return True


def load_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def materialize(dest: Path, manifest: Optional[dict] = None) -> dict[str, FixtureRepo]:
    """Build every fixture repository under `dest`, keyed by full name."""
    manifest = manifest or load_manifest()
    dest.mkdir(parents=True, exist_ok=True)
    repos: dict[str, FixtureRepo] = {}
    for spec in manifest["repositories"]:
        repos[spec["full_name"]] = _build_repo(dest, spec)
    return repos


# --- internals ------------------------------------------------------------
def _build_repo(dest: Path, spec: dict) -> FixtureRepo:
    work = dest / spec["full_name"].replace("/", "__")
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    if spec.get("path"):
        _copy_tree(FIXTURE_ROOT / spec["path"], work)
    if spec.get("generated") == "secrets_trap":
        _write_generated(work, planted_secrets.files())
    if spec.get("generated") == "oversized":
        # One line per repetition: still a plausible generated source file.
        line = "GENERATED = 'x' * 64  # padding line\n"
        (work / "huge.py").write_text(
            line * (OVERSIZED_BYTES // len(line) + 1), encoding="utf-8", newline="\n"
        )

    branch = spec.get("default_branch") or "main"
    _run(["git", "init", "--quiet", f"--initial-branch={branch}"], work)
    _run(["git", "config", "user.name", _GIT_ENV["GIT_AUTHOR_NAME"]], work)
    _run(["git", "config", "user.email", _GIT_ENV["GIT_AUTHOR_EMAIL"]], work)
    _run(["git", "config", "commit.gpgsign", "false"], work)

    shas = tuple(_commit(work, commit) for commit in spec["commits"])
    return FixtureRepo(
        full_name=spec["full_name"],
        path=work,
        provider_repo_id=spec["provider_repo_id"],
        default_branch=branch,
        metadata=spec,
        commit_shas=shas,
    )


def _commit(work: Path, commit: dict) -> str:
    paths = commit["paths"]
    if paths == ["*"]:
        _run(["git", "add", "-A", "--", "."], work)
    else:
        existing = [p for p in paths if (work / p).exists()]
        if existing:
            _run(["git", "add", "--", *existing], work)
    env = dict(_GIT_ENV)
    env["GIT_AUTHOR_DATE"] = commit["date"]
    env["GIT_COMMITTER_DATE"] = commit["date"]
    _run(
        ["git", "commit", "--quiet", "--allow-empty", "-m", commit["message"]],
        work,
        env=env,
    )
    return _run(["git", "rev-parse", "HEAD"], work).strip()


def _copy_tree(src: Path, dest: Path) -> None:
    if not src.is_dir():
        raise FileNotFoundError(f"fixture directory missing: {src}")
    shutil.copytree(src, dest, dirs_exist_ok=True)


def _write_generated(work: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = work / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")


def _run(cmd: list[str], cwd: Path, env: Optional[dict] = None) -> str:
    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        env={**os.environ, **(env or _GIT_ENV)},
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed in {cwd}: {result.stderr.strip()}")
    return result.stdout
