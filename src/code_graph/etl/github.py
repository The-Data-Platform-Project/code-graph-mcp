"""Fetching a repository from GitHub without git: resolve a commit, stream its tarball.

The tarball endpoint returns one gzip stream of the tree at a commit. It is
read as a stream and written out file by file, so memory stays flat however
big the repo is, and nothing but regular files is ever created: symlinks,
devices and anything that would land outside the target directory are skipped,
not trusted. Files over the indexer's own size cap are skipped here too, since
the indexer would only skip them after they had taken up disk.

The token is a tenant's fine-grained token (read-only *Contents* and
*Metadata* are enough). Public repos work without one, at GitHub's
unauthenticated rate limit.
"""

from __future__ import annotations

import json
import re
import shutil
import tarfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

API = "https://api.github.com"
TIMEOUT_SECONDS = 30

# Same rule as the CHECK on control.repo_connections.external_repo.
EXTERNAL_REPO_RE = re.compile(r"^[A-Za-z0-9-]+/(?!\.\.?$)[A-Za-z0-9._-]+$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


class GitHubError(RuntimeError):
    """A GitHub request failed; the message is safe to show the tenant."""


def _request(url: str, token: str | None, accept: str) -> urllib.request.Request:
    headers = {
        "Accept": accept,
        "User-Agent": "code-graph-indexer",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def _explain(status: int, what: str) -> GitHubError:
    if status in (401,):
        return GitHubError(f"GitHub refused the token for {what}: expired or revoked")
    if status in (403, 429):
        return GitHubError(f"GitHub refused {what}: rate limit or missing permission")
    if status == 404:
        return GitHubError(
            f"{what} not found: the repository is private and the connection's token "
            "cannot see it, or the branch does not exist"
        )
    return GitHubError(f"GitHub returned {status} for {what}")


def _check_repo(external_repo: str) -> str:
    if not EXTERNAL_REPO_RE.match(external_repo or ""):
        raise GitHubError(f"invalid GitHub repository {external_repo!r}")
    return external_repo


def get_json(path: str, token: str | None) -> dict:
    req = _request(f"{API}{path}", token, "application/vnd.github+json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
            return json.load(res)
    except urllib.error.HTTPError as exc:
        raise _explain(exc.code, path) from None
    except urllib.error.URLError as exc:
        raise GitHubError(f"could not reach GitHub: {exc.reason}") from None


def default_branch(external_repo: str, token: str | None) -> str:
    repo = _check_repo(external_repo)
    return get_json(f"/repos/{repo}", token)["default_branch"]


def resolve_commit(external_repo: str, ref: str, token: str | None) -> str:
    """The full SHA that `ref` (a branch, tag or SHA) points at right now."""
    repo = _check_repo(external_repo)
    quoted = urllib.parse.quote(ref, safe="")
    sha = get_json(f"/repos/{repo}/commits/{quoted}", token).get("sha", "")
    if not SHA_RE.match(sha):
        raise GitHubError(f"GitHub returned no commit for {repo}@{ref}")
    return sha


def _safe_member_path(name: str) -> PurePosixPath | None:
    """The member's path below the tarball's top-level directory, if it is safe."""
    parts = PurePosixPath(name).parts
    if len(parts) < 2:
        return None  # the top-level "<owner>-<repo>-<sha>/" directory itself
    rel = PurePosixPath(*parts[1:])
    if rel.is_absolute() or any(p in ("..", "") for p in rel.parts):
        return None
    return rel


def download_tree(
    external_repo: str,
    sha: str,
    token: str | None,
    dest: Path,
    max_file_bytes: int,
    max_total_bytes: int = 2_000_000_000,
) -> dict:
    """Write the tree at `sha` into `dest` (created, must not exist). Returns counts."""
    repo = _check_repo(external_repo)
    if not SHA_RE.match(sha):
        raise GitHubError(f"not a commit SHA: {sha!r}")
    dest.mkdir(parents=True)
    req = _request(f"{API}/repos/{repo}/tarball/{sha}", token, "application/vnd.github+json")
    files = skipped = total = 0
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res, tarfile.open(
            fileobj=res, mode="r|gz"
        ) as tar:
            for member in tar:
                if not member.isfile():
                    continue  # directories are made on demand; links are never followed
                rel = _safe_member_path(member.name)
                if rel is None or member.size > max_file_bytes:
                    skipped += 1
                    continue
                total += member.size
                if total > max_total_bytes:
                    raise GitHubError(
                        f"{repo} is larger than {max_total_bytes // 1_000_000} MB of "
                        "indexable files; not indexed"
                    )
                target = dest.joinpath(*rel.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                src = tar.extractfile(member)
                if src is None:
                    skipped += 1
                    continue
                with src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out, 1 << 16)
                files += 1
    except urllib.error.HTTPError as exc:
        raise _explain(exc.code, f"{repo}@{sha[:7]} tarball") from None
    except urllib.error.URLError as exc:
        raise GitHubError(f"could not reach GitHub: {exc.reason}") from None
    except tarfile.TarError as exc:
        raise GitHubError(f"unreadable tarball for {repo}: {exc}") from None
    return {"files": files, "skipped": skipped, "bytes": total}
