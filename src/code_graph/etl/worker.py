"""Run one index job: GitHub commit → tenant graph.

    claim ─▶ open the connection's token ─▶ resolve branch to a commit
          ─▶ unchanged since the last run? done : download tarball
          ─▶ index into tenant_<slug> (incremental if the repo is already there)
          ─▶ record the commit, pin previews to it ─▶ delete the scratch copy

The graph code is the local indexer, unchanged: it is pointed at the tenant's
schema through the connection's search_path, exactly as GRAPH_SCHEMA does for
the container, and at a scratch directory as its workspaces root. The memory
discipline (one parse tree at a time) carries over, so a 1 GB Lambda is plenty.
"""

from __future__ import annotations

import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from .. import control, secretbox
from ..config import Config
from ..indexer import Indexer
from . import github, jobs

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class WorkerSettings:
    # A role that may write every tenant schema and the control plane — the
    # database owner, not the web app's restricted role.
    database_url: str
    # GITHUB_TOKEN_KEY, parsed. None only where no connection uses a token.
    token_key: bytes | None
    scratch_dir: Path
    max_file_bytes: int = 1_500_000
    commit_batch_files: int = 200


def tenant_dsn(database_url: str, schema: str) -> str:
    """The same database, with every unqualified table resolving in `schema`."""
    if not control.SCHEMA_RE.match(schema):
        raise ValueError(f"invalid tenant schema {schema!r}")
    return make_conninfo(database_url, options=f"-csearch_path={schema}")


def _repo_indexed(con: psycopg.Connection, schema: str, repo: str) -> bool:
    return con.execute(
        sql.SQL("SELECT 1 AS ok FROM {}.repos WHERE name = %s").format(sql.Identifier(schema)),
        (repo,),
    ).fetchone() is not None


def run_job(settings: WorkerSettings, job_id: int) -> dict:
    """Run a job to completion and record the outcome. Returns a summary.

    A failure is recorded on the job and returned, not raised: the queue
    should not redeliver a job that failed for a reason a retry will not fix
    (a revoked token, a deleted repo). Only a crash of the runtime itself
    leaves the job 'running' for the queue to retry.
    """
    with psycopg.connect(settings.database_url, row_factory=dict_row) as con:
        job = jobs.claim(con, job_id)
        con.commit()
        if job is None:
            return {"job_id": job_id, "status": "skipped"}

        scratch = settings.scratch_dir / f"job-{job_id}"
        started = time.monotonic()
        try:
            summary = _run(settings, con, job, scratch)
            jobs.finish(
                con, job_id, ok=True, commit_sha=summary["commit_sha"], stats=summary["stats"]
            )
            con.commit()
            return {"job_id": job_id, "status": "succeeded", **summary}
        except Exception as exc:  # recorded on the job; the tenant sees it in the app
            con.rollback()
            message = str(exc) if isinstance(exc, (github.GitHubError, ValueError)) else (
                f"{type(exc).__name__}: {exc}"
            )
            log.exception("index job %s failed", job_id)
            jobs.finish(
                con, job_id, ok=False, error=message,
                stats={"seconds": round(time.monotonic() - started, 1)},
            )
            con.commit()
            return {"job_id": job_id, "status": "failed", "error": message}
        finally:
            shutil.rmtree(scratch, ignore_errors=True)


def _run(settings: WorkerSettings, con: psycopg.Connection, job: dict, scratch: Path) -> dict:
    started = time.monotonic()
    token = None
    if job["token_ciphertext"]:
        if settings.token_key is None:
            raise ValueError("GITHUB_TOKEN_KEY is not configured on the indexer")
        token = secretbox.open_sealed(
            settings.token_key, job["token_ciphertext"], secretbox.token_aad(job["tenant_id"])
        )

    repo = job["external_repo"]
    branch = job["branch"] or github.default_branch(repo, token)
    sha = github.resolve_commit(repo, branch, token)

    schema = job["schema_name"]
    control.ensure_tenant_schema(con, schema)
    con.commit()
    already = _repo_indexed(con, schema, job["repo_name"])

    if already and sha == job["git_ref"] and job["trigger"] != "manual":
        return {
            "commit_sha": sha,
            "stats": {"unchanged": True, "branch": branch,
                      "seconds": round(time.monotonic() - started, 1)},
        }

    workspace = scratch / "ws"
    fetched = github.download_tree(
        repo, sha, token, workspace / job["repo_name"], settings.max_file_bytes
    )
    config = Config(
        database_url=tenant_dsn(settings.database_url, schema),
        workspaces_root=workspace,
        host="127.0.0.1",
        port=0,
        max_file_bytes=settings.max_file_bytes,
        commit_batch_files=settings.commit_batch_files,
    )
    indexer = Indexer(config)
    root = workspace / job["repo_name"]
    result = (
        indexer.reindex(job["repo_name"], root, job["repo_name"])
        if already
        else indexer.index_full(job["repo_name"], root, job["repo_name"])
    )
    return {
        "commit_sha": sha,
        "stats": {
            "branch": branch,
            "mode": result.status,
            "files_downloaded": fetched["files"],
            "files_indexed": result.files_indexed,
            "files_skipped": result.files_skipped,
            "files_deleted": result.files_deleted,
            "nodes": result.nodes,
            "edges": result.edges,
            "seconds": round(time.monotonic() - started, 1),
        },
    }
