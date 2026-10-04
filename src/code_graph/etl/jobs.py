"""The index job log, `control.index_jobs`: the queue's source of truth.

The message queue (SQS on AWS) only carries job ids. Whether a job should run,
and what it ran, is decided here, so a duplicated or late message is harmless:
claiming is a conditional UPDATE, and only one claimant wins.

Every function runs in the caller's transaction; the caller commits.
"""

from __future__ import annotations

import json

import psycopg

# A Lambda run is capped at 15 minutes. A job still 'running' after this long
# died with its runtime (timeout, out of memory) and may be claimed again.
STALE_RUNNING = "20 minutes"
MAX_ERROR_CHARS = 2000


def enqueue(con: psycopg.Connection, tenant_id: int, repo_name: str, trigger: str) -> int | None:
    """Queue a job. Returns its id, or None if one is already queued for this repo.

    A burst of pushes therefore collapses into a single run, which will index
    whatever the branch points at when it starts.
    """
    row = con.execute(
        "INSERT INTO control.index_jobs (tenant_id, repo_name, trigger) "
        "VALUES (%s, %s, %s) "
        "ON CONFLICT (tenant_id, repo_name) WHERE status = 'queued' DO NOTHING "
        "RETURNING id",
        (tenant_id, repo_name, trigger),
    ).fetchone()
    return row["id"] if row else None


def scheduled_connections(con: psycopg.Connection) -> list[dict]:
    """Every connection the daily run should refresh."""
    return con.execute(
        "SELECT c.tenant_id, c.repo_name FROM control.repo_connections c "
        "JOIN control.tenants t ON t.id = c.tenant_id "
        "WHERE c.index_daily AND t.status = 'active' "
        "ORDER BY c.tenant_id, c.repo_name"
    ).fetchall()


def push_candidates(con: psycopg.Connection, full_name: str) -> list[dict]:
    """Connections to the pushed repository that want push-triggered indexing."""
    return con.execute(
        "SELECT c.tenant_id, c.repo_name, c.branch FROM control.repo_connections c "
        "JOIN control.tenants t ON t.id = c.tenant_id "
        "WHERE lower(c.external_repo) = lower(%s) AND c.index_on_push "
        "AND t.status = 'active'",
        (full_name,),
    ).fetchall()


def connection_exists(con: psycopg.Connection, tenant_id: int, repo_name: str) -> bool:
    return con.execute(
        "SELECT 1 AS ok FROM control.repo_connections c "
        "JOIN control.tenants t ON t.id = c.tenant_id "
        "WHERE c.tenant_id = %s AND c.repo_name = %s AND t.status = 'active'",
        (tenant_id, repo_name),
    ).fetchone() is not None


def claim(con: psycopg.Connection, job_id: int) -> dict | None:
    """Mark a job running and return everything needed to run it, or None.

    None means someone else has it, it already finished, or its tenant or
    connection is gone — in every case, the message is simply dropped.
    """
    row = con.execute(
        "UPDATE control.index_jobs SET status = 'running', started_at = now(), "
        "attempts = attempts + 1, error = NULL "
        "WHERE id = %s AND (status = 'queued' OR "
        f"(status = 'running' AND started_at < now() - interval '{STALE_RUNNING}')) "
        "RETURNING id, tenant_id, repo_name, trigger",
        (job_id,),
    ).fetchone()
    if row is None:
        return None
    detail = con.execute(
        "SELECT t.slug, t.schema_name, c.external_repo, c.branch, c.git_ref, "
        "c.github_token_id, k.token_ciphertext "
        "FROM control.repo_connections c "
        "JOIN control.tenants t ON t.id = c.tenant_id "
        "LEFT JOIN control.github_tokens k "
        "  ON k.id = c.github_token_id AND k.tenant_id = c.tenant_id "
        "WHERE c.tenant_id = %s AND c.repo_name = %s AND t.status = 'active'",
        (row["tenant_id"], row["repo_name"]),
    ).fetchone()
    if detail is None:
        finish(con, job_id, ok=False, error="connection or tenant no longer active")
        return None
    return {**row, **detail}


def finish(
    con: psycopg.Connection,
    job_id: int,
    *,
    ok: bool,
    commit_sha: str | None = None,
    error: str | None = None,
    stats: dict | None = None,
) -> None:
    row = con.execute(
        "UPDATE control.index_jobs SET status = %s, finished_at = now(), "
        "commit_sha = COALESCE(%s, commit_sha), error = %s, stats = %s "
        "WHERE id = %s RETURNING tenant_id, repo_name",
        (
            "succeeded" if ok else "failed",
            commit_sha,
            (error or "")[:MAX_ERROR_CHARS] or None,
            json.dumps(stats) if stats is not None else None,
            job_id,
        ),
    ).fetchone()
    if ok and row and commit_sha:
        # Previews read the exact commit the graph's line numbers came from.
        con.execute(
            "UPDATE control.repo_connections SET git_ref = %s, last_indexed_at = now() "
            "WHERE tenant_id = %s AND repo_name = %s",
            (commit_sha, row["tenant_id"], row["repo_name"]),
        )


def fail_stale(con: psycopg.Connection) -> int:
    """Close out jobs whose runtime died long ago (the queue gave up on them)."""
    cur = con.execute(
        "UPDATE control.index_jobs SET status = 'failed', finished_at = now(), "
        "error = 'the indexer stopped before finishing (timeout or out of memory)' "
        "WHERE status = 'running' AND started_at < now() - interval '2 hours'"
    )
    return cur.rowcount
