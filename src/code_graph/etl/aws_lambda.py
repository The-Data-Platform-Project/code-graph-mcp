"""AWS Lambda entry points for the indexer. One image, two functions.

`trigger_handler`  behind a Lambda Function URL and the daily EventBridge
                   Scheduler rule:
                     POST /github    GitHub push webhook
                     POST /enqueue   "Index now" from the web app
                     GET  /health    liveness, reveals nothing
                     {"source": "schedule"} (from the scheduler, not HTTP)
                   It only writes job rows and queue messages — it never indexes,
                   so it answers GitHub well inside its 10-second webhook timeout.

`worker_handler`   consumes the SQS queue, one job per invocation.

Secrets come from SSM Parameter Store SecureStrings under $SSM_PREFIX
(standard parameters are free; Secrets Manager is not), read once per cold
start. Plain environment variables of the same names override them, for runs
outside AWS.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path

import psycopg
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row

from .. import control, secretbox
from . import triggers, worker

log = logging.getLogger()
log.setLevel(logging.INFO)

# SSM parameter (under $SSM_PREFIX) → environment variable of the same meaning.
PARAMETERS = {
    "database-url": "DATABASE_URL",
    "github-token-key": "GITHUB_TOKEN_KEY",
    "indexer-secret": "INDEXER_SECRET",
    # Optional: Supabase's CA (PEM). With it the database certificate is fully
    # verified (verify-full); without it the URL's own sslmode applies.
    "database-ca-cert": "DATABASE_CA_CERT",
}

_settings: dict[str, str] | None = None
_control_ready = False

# Serializes concurrent cold starts' DDL (same idea as db._SCHEMA_LOCK_KEY).
_CONTROL_LOCK_KEY = 0x6367_0002


def settings() -> dict[str, str]:
    global _settings
    if _settings is None:
        values = {env: os.environ.get(env, "") for env in PARAMETERS.values()}
        missing = [name for name, env in PARAMETERS.items() if not values[env]]
        prefix = os.environ.get("SSM_PREFIX", "").rstrip("/")
        if missing and prefix:
            import boto3  # present in the Lambda Python runtime image

            res = boto3.client("ssm").get_parameters(
                Names=[f"{prefix}/{name}" for name in missing], WithDecryption=True
            )
            for p in res["Parameters"]:
                values[PARAMETERS[p["Name"].rsplit("/", 1)[1]]] = p["Value"]
        _settings = values
    return _settings


_database_url: str | None = None


def database_url() -> str:
    """DATABASE_URL, pinned to the database's CA when DATABASE_CA_CERT is set."""
    global _database_url
    if _database_url is None:
        url = settings()["DATABASE_URL"]
        ca = settings().get("DATABASE_CA_CERT", "").replace("\\n", "\n").strip()
        if ca:
            path = Path(os.environ.get("SCRATCH_DIR", "/tmp")) / "database-ca.pem"
            path.write_text(ca + "\n", encoding="utf-8")
            url = make_conninfo(url, sslmode="verify-full", sslrootcert=str(path))
        _database_url = url
    return _database_url


def _connect() -> psycopg.Connection:
    global _control_ready
    con = psycopg.connect(database_url(), row_factory=dict_row, connect_timeout=15)
    if not _control_ready:
        con.execute("SELECT pg_advisory_xact_lock(%s)", (_CONTROL_LOCK_KEY,))
        control.ensure_control(con)
        con.commit()
        _control_ready = True
    return con


def _send(job_ids: list[int]) -> None:
    if not job_ids:
        return
    import boto3

    queue_url = os.environ["QUEUE_URL"]
    sqs = boto3.client("sqs")
    # SendMessageBatch takes at most 10 entries.
    for i in range(0, len(job_ids), 10):
        chunk = job_ids[i : i + 10]
        sqs.send_message_batch(
            QueueUrl=queue_url,
            Entries=[{"Id": str(j), "MessageBody": json.dumps({"job_id": j})} for j in chunk],
        )


def _http(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(body),
    }


def trigger_handler(event: dict, context=None) -> dict:
    if event.get("source") == "schedule":
        with _connect() as con:
            outcome = triggers.on_schedule(con)
            con.commit()
        _send(outcome.job_ids)
        log.info("schedule: %s", outcome.body)
        return outcome.body

    http = (event.get("requestContext") or {}).get("http") or {}
    method, path = http.get("method", ""), event.get("rawPath", "")
    if method == "GET" and path == "/health":
        return _http(200, {"status": "ok"})
    if method != "POST" or path not in ("/github", "/enqueue"):
        return _http(404, {"error": "not found"})

    raw = event.get("body") or ""
    body = base64.b64decode(raw) if event.get("isBase64Encoded") else raw.encode("utf-8")
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    master = settings()["INDEXER_SECRET"]
    if not master:
        return _http(503, {"error": "indexer secret not configured"})

    with _connect() as con:
        handler = triggers.on_github if path == "/github" else triggers.on_app
        outcome = handler(con, master, headers, body)
        con.commit()
    _send(outcome.job_ids)
    log.info("%s %s -> %s %s", method, path, outcome.status, outcome.body)
    return _http(outcome.status, outcome.body)


def worker_handler(event: dict, context=None) -> dict:
    key_hex = settings()["GITHUB_TOKEN_KEY"]
    cfg = worker.WorkerSettings(
        database_url=database_url(),
        token_key=secretbox.parse_key(key_hex) if key_hex else None,
        scratch_dir=Path(os.environ.get("SCRATCH_DIR", "/tmp")),
        max_file_bytes=int(os.environ.get("MAX_FILE_BYTES", "1500000")),
    )
    with _connect():
        pass  # control schema ensured before the first claim
    results = []
    for record in event.get("Records", []):
        job_id = int(json.loads(record["body"])["job_id"])
        result = worker.run_job(cfg, job_id)
        log.info("job %s: %s", job_id, result)
        results.append(result)
    return {"results": results}
