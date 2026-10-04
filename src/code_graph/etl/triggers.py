"""The three ways a job starts, independent of where they run.

Each returns the ids of newly queued jobs; the caller (aws_lambda.py) puts
those on the queue after committing. A repo that already has a queued job is
not queued again, so nothing is sent for it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import psycopg

from . import jobs, signing


@dataclass
class Outcome:
    status: int
    body: dict
    job_ids: list[int] = field(default_factory=list)


def on_schedule(con: psycopg.Connection) -> Outcome:
    """The daily run: close out dead jobs, then queue every daily connection."""
    stale = jobs.fail_stale(con)
    queued = []
    for row in jobs.scheduled_connections(con):
        job_id = jobs.enqueue(con, row["tenant_id"], row["repo_name"], "schedule")
        if job_id is not None:
            queued.append(job_id)
    return Outcome(200, {"queued": len(queued), "stale_failed": stale}, queued)


def on_github(
    con: psycopg.Connection, master: str, headers: dict[str, str], body: bytes
) -> Outcome:
    """A GitHub webhook delivery. Only `push` (and `ping`) are acted on.

    The delivery is accepted for a connection only if it is signed with *that
    connection's* derived secret, so a signature valid for one tenant cannot
    queue work for another that happens to connect the same repository.
    """
    event = headers.get("x-github-event", "")
    try:
        payload = json.loads(body or b"{}")
        full_name = payload["repository"]["full_name"]
    except (ValueError, KeyError, TypeError):
        return Outcome(400, {"error": "not a GitHub repository event"})

    signature = headers.get("x-hub-signature-256")
    matching = [
        c
        for c in jobs.push_candidates(con, full_name)
        if signing.verify_github_signature(
            signing.webhook_secret(master, c["tenant_id"], c["repo_name"]), body, signature
        )
    ]
    if not matching:
        # Unsigned, wrongly signed, or for a repo nobody connected: same answer.
        return Outcome(401, {"error": "signature does not match any connection"})
    if event == "ping":
        return Outcome(200, {"pong": True, "connections": len(matching)})
    if event != "push":
        return Outcome(202, {"ignored": event})

    ref = payload.get("ref", "")
    default = payload["repository"].get("default_branch", "")
    queued = []
    for c in matching:
        if ref != f"refs/heads/{c['branch'] or default}":
            continue  # a push to some other branch than the one indexed
        job_id = jobs.enqueue(con, c["tenant_id"], c["repo_name"], "push")
        if job_id is not None:
            queued.append(job_id)
    return Outcome(202, {"queued": len(queued)}, queued)


def on_app(
    con: psycopg.Connection, master: str, headers: dict[str, str], body: bytes
) -> Outcome:
    """"Index now" from the web app, which signs the request with the master secret."""
    text = (body or b"").decode("utf-8", errors="replace")
    if not signing.verify_app_request(
        master, text, headers.get("x-cg-timestamp"), headers.get("x-cg-signature")
    ):
        return Outcome(401, {"error": "bad or expired signature"})
    try:
        payload = json.loads(text)
        tenant_id = int(payload["tenant_id"])
        repo_name = str(payload["repo_name"])
    except (ValueError, KeyError, TypeError):
        return Outcome(400, {"error": "expected {tenant_id, repo_name}"})
    if not jobs.connection_exists(con, tenant_id, repo_name):
        return Outcome(404, {"error": "no such connection"})
    job_id = jobs.enqueue(con, tenant_id, repo_name, "manual")
    if job_id is None:
        return Outcome(200, {"queued": False, "reason": "a run is already queued"})
    return Outcome(202, {"queued": True, "job_id": job_id}, [job_id])
