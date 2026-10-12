"""The cloud indexing pipeline: triggers, the job log, the worker, the tarball fetch.

GitHub is never called: `etl.github` is replaced per test. Everything else is
real, including indexing the sample repo into a tenant schema.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import shutil
import tarfile
import time

import pytest

from code_graph import control, secretbox
from code_graph.etl import github, jobs, signing, triggers, worker

MASTER = "m" * 64
KEY = bytes(range(32))
SHA1 = "a" * 40
SHA2 = "b" * 40


@pytest.fixture
def plane(fresh_db):
    control.ensure_control(fresh_db)
    fresh_db.commit()
    return fresh_db


def _tenant(con, slug, status="active"):
    tenant_id, _ = control.upsert_tenant(con, slug, slug)
    con.execute("UPDATE control.tenants SET status = %s WHERE id = %s", (status, tenant_id))
    return tenant_id


def _connect_repo(con, tenant_id, repo="svc", external="acme/svc", **cols):
    fields = {"branch": None, "index_daily": True, "index_on_push": True,
              "github_token_id": None, **cols}
    con.execute(
        "INSERT INTO control.repo_connections (tenant_id, repo_name, external_repo, branch, "
        "index_daily, index_on_push, github_token_id) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (tenant_id, repo, external, fields["branch"], fields["index_daily"],
         fields["index_on_push"], fields["github_token_id"]),
    )


def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _push(full_name="acme/svc", ref="refs/heads/main", default="main") -> bytes:
    return json.dumps(
        {"ref": ref, "repository": {"full_name": full_name, "default_branch": default}}
    ).encode()


# ── signing ─────────────────────────────────────────────────────────────────


def test_webhook_secrets_differ_per_connection():
    a = signing.webhook_secret(MASTER, 1, "svc")
    assert a == signing.webhook_secret(MASTER, 1, "svc")
    assert a != signing.webhook_secret(MASTER, 2, "svc")
    assert a != signing.webhook_secret(MASTER, 1, "other")


def test_webhook_secret_matches_the_app():
    """frontend/lib/indexer.ts derives the same value (checked against Node's crypto)."""
    assert signing.webhook_secret("master-secret", 42, "svc") == (
        "90d8e757c04e74c4eea4170c46ab2dc96648bd5b6470d06032fcb3462bda8e7c"
    )


def test_app_signature_expires():
    body = '{"tenant_id": 1, "repo_name": "svc"}'
    now = int(time.time())
    sig = signing.sign_app_request(MASTER, now, body)
    assert signing.verify_app_request(MASTER, body, str(now), sig)
    assert not signing.verify_app_request(MASTER, body + " ", str(now), sig)
    assert not signing.verify_app_request(MASTER, body, str(now), sig, now=now + 301)
    assert not signing.verify_app_request("x" * 64, body, str(now), sig)


# ── triggers ────────────────────────────────────────────────────────────────


def test_push_queues_only_the_connection_whose_secret_signed_it(plane):
    a, b = _tenant(plane, "a"), _tenant(plane, "b")
    _connect_repo(plane, a)
    _connect_repo(plane, b)  # another tenant connected the same repository
    body = _push()
    headers = {"x-github-event": "push",
               "x-hub-signature-256": _sign(signing.webhook_secret(MASTER, a, "svc"), body)}
    out = triggers.on_github(plane, MASTER, headers, body)
    assert out.status == 202 and len(out.job_ids) == 1
    queued = plane.execute("SELECT tenant_id, trigger FROM control.index_jobs").fetchall()
    assert queued == [{"tenant_id": a, "trigger": "push"}]


def test_push_is_refused_unsigned_or_for_unknown_repos(plane):
    a = _tenant(plane, "a")
    _connect_repo(plane, a)
    body = _push()
    assert triggers.on_github(plane, MASTER, {"x-github-event": "push"}, body).status == 401
    forged = {"x-github-event": "push", "x-hub-signature-256": _sign("guess", body)}
    assert triggers.on_github(plane, MASTER, forged, body).status == 401
    other = _push("someone/else")
    signed = {"x-github-event": "push",
              "x-hub-signature-256": _sign(signing.webhook_secret(MASTER, a, "svc"), other)}
    assert triggers.on_github(plane, MASTER, signed, other).status == 401


def test_push_to_another_branch_or_disabled_connection_queues_nothing(plane):
    a = _tenant(plane, "a")
    _connect_repo(plane, a, branch="release")
    _connect_repo(plane, a, repo="quiet", index_on_push=False)
    body = _push(ref="refs/heads/main")
    headers = {"x-github-event": "push",
               "x-hub-signature-256": _sign(signing.webhook_secret(MASTER, a, "svc"), body)}
    out = triggers.on_github(plane, MASTER, headers, body)
    assert out.status == 202 and out.job_ids == []
    body = _push(ref="refs/heads/release")
    headers["x-hub-signature-256"] = _sign(signing.webhook_secret(MASTER, a, "svc"), body)
    assert len(triggers.on_github(plane, MASTER, headers, body).job_ids) == 1


def test_ping_is_answered_for_a_signed_connection(plane):
    a = _tenant(plane, "a")
    _connect_repo(plane, a)
    body = _push()
    headers = {"x-github-event": "ping",
               "x-hub-signature-256": _sign(signing.webhook_secret(MASTER, a, "svc"), body)}
    out = triggers.on_github(plane, MASTER, headers, body)
    assert out.status == 200 and out.body["pong"] and out.job_ids == []


def test_app_request_queues_once(plane):
    a = _tenant(plane, "a")
    _connect_repo(plane, a)
    body = json.dumps({"tenant_id": a, "repo_name": "svc"})
    ts = int(time.time())
    headers = {"x-cg-timestamp": str(ts),
               "x-cg-signature": signing.sign_app_request(MASTER, ts, body)}
    first = triggers.on_app(plane, MASTER, headers, body.encode())
    assert first.status == 202 and len(first.job_ids) == 1
    again = triggers.on_app(plane, MASTER, headers, body.encode())
    assert again.status == 200 and again.job_ids == []
    missing = json.dumps({"tenant_id": a, "repo_name": "nope"})
    headers["x-cg-signature"] = signing.sign_app_request(MASTER, ts, missing)
    assert triggers.on_app(plane, MASTER, headers, missing.encode()).status == 404


def test_schedule_queues_daily_connections_of_active_tenants(plane):
    a = _tenant(plane, "a")
    s = _tenant(plane, "s", status="suspended")
    _connect_repo(plane, a)
    _connect_repo(plane, a, repo="manual-only", index_daily=False)
    _connect_repo(plane, s)
    out = triggers.on_schedule(plane)
    assert out.body["queued"] == 1
    rows = plane.execute("SELECT tenant_id, repo_name FROM control.index_jobs").fetchall()
    assert rows == [{"tenant_id": a, "repo_name": "svc"}]


# ── worker ──────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_github(monkeypatch, sample_root):
    """GitHub, as far as the worker can tell: one repo whose head is `state['sha']`."""
    state = {"sha": SHA1, "tokens": [], "downloads": 0, "fail": None}

    def default_branch(repo, token):
        state["tokens"].append(token)
        return "main"

    def resolve_commit(repo, ref, token):
        if state["fail"]:
            raise github.GitHubError(state["fail"])
        return state["sha"]

    def download_tree(repo, sha, token, dest, max_file_bytes):
        state["downloads"] += 1
        shutil.copytree(sample_root, dest)
        return {"files": 4, "skipped": 0, "bytes": 1}

    monkeypatch.setattr(github, "default_branch", default_branch)
    monkeypatch.setattr(github, "resolve_commit", resolve_commit)
    monkeypatch.setattr(github, "download_tree", download_tree)
    return state


def _settings(fresh_dsn, tmp_path):
    return worker.WorkerSettings(database_url=fresh_dsn, token_key=KEY,
                                 scratch_dir=tmp_path / "scratch")


def test_worker_indexes_into_the_tenant_schema(plane, fresh_dsn, tmp_path, fake_github):
    a = _tenant(plane, "acme")
    sealed = secretbox.seal(KEY, "github_pat_secret", secretbox.token_aad(a))
    tok = plane.execute(
        "INSERT INTO control.github_tokens (tenant_id, label, github_login, token_ciphertext, "
        "token_hint) VALUES (%s, 'work', 'me', %s, 'cret') RETURNING id",
        (a, sealed),
    ).fetchone()["id"]
    _connect_repo(plane, a, github_token_id=tok)
    job = jobs.enqueue(plane, a, "svc", "manual")
    plane.commit()

    result = worker.run_job(_settings(fresh_dsn, tmp_path), job)

    assert result["status"] == "succeeded", result
    assert fake_github["tokens"] == ["github_pat_secret"]  # opened with the tenant's key
    n = plane.execute("SELECT COUNT(*) AS n FROM tenant_acme.nodes").fetchone()["n"]
    assert n > 0
    conn = plane.execute(
        "SELECT git_ref, last_indexed_at FROM control.repo_connections"
    ).fetchone()
    assert conn["git_ref"] == SHA1 and conn["last_indexed_at"] is not None
    row = plane.execute("SELECT status, commit_sha, stats FROM control.index_jobs").fetchone()
    assert row["status"] == "succeeded" and row["commit_sha"] == SHA1
    assert row["stats"]["mode"] == "indexed"
    assert not (tmp_path / "scratch" / f"job-{job}").exists()  # clone deleted


def test_worker_skips_an_unchanged_commit_then_reindexes_a_new_one(
    plane, fresh_dsn, tmp_path, fake_github
):
    a = _tenant(plane, "acme")
    _connect_repo(plane, a)
    cfg = _settings(fresh_dsn, tmp_path)

    def run(trigger):
        job = jobs.enqueue(plane, a, "svc", trigger)
        plane.commit()
        return worker.run_job(cfg, job)

    assert run("schedule")["status"] == "succeeded"
    second = run("schedule")
    assert second["stats"].get("unchanged") is True
    assert fake_github["downloads"] == 1

    fake_github["sha"] = SHA2
    third = run("push")
    assert third["status"] == "succeeded" and third["stats"]["mode"] == "reindexed"
    assert plane.execute(
        "SELECT git_ref FROM control.repo_connections"
    ).fetchone()["git_ref"] == SHA2


def test_worker_records_a_failure_on_the_job(plane, fresh_dsn, tmp_path, fake_github):
    a = _tenant(plane, "acme")
    _connect_repo(plane, a)
    job = jobs.enqueue(plane, a, "svc", "manual")
    plane.commit()
    fake_github["fail"] = "GitHub refused the token for x: expired or revoked"
    result = worker.run_job(_settings(fresh_dsn, tmp_path), job)
    assert result["status"] == "failed"
    row = plane.execute("SELECT status, error FROM control.index_jobs").fetchone()
    assert row == {"status": "failed", "error": fake_github["fail"]}


def test_a_job_is_claimed_once(plane, fresh_dsn, tmp_path, fake_github):
    a = _tenant(plane, "acme")
    _connect_repo(plane, a)
    job = jobs.enqueue(plane, a, "svc", "manual")
    plane.commit()
    cfg = _settings(fresh_dsn, tmp_path)
    assert worker.run_job(cfg, job)["status"] == "succeeded"
    assert worker.run_job(cfg, job)["status"] == "skipped"  # a duplicated message


def test_tenant_dsn_refuses_odd_schema_names():
    with pytest.raises(ValueError):
        worker.tenant_dsn("postgresql://x@h/db", "public; DROP")
    assert "search_path=tenant_ok" in worker.tenant_dsn("postgresql://x@h/db", "tenant_ok")


# ── tarball extraction ──────────────────────────────────────────────────────


def _tarball(members: list[tuple[tarfile.TarInfo, bytes | None]]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for info, data in members:
            tar.addfile(info, io.BytesIO(data) if data is not None else None)
    return buf.getvalue()


def _file(name: str, data: bytes) -> tuple[tarfile.TarInfo, bytes]:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    return info, data


def test_download_tree_writes_only_safe_regular_files(monkeypatch, tmp_path):
    link = tarfile.TarInfo("acme-svc-abc/link")
    link.type = tarfile.SYMTYPE
    link.linkname = "/etc/passwd"
    top = tarfile.TarInfo("acme-svc-abc")
    top.type = tarfile.DIRTYPE
    blob = _tarball([
        (top, None),
        _file("acme-svc-abc/app.py", b"print(1)\n"),
        _file("acme-svc-abc/src/util.js", b"export const x = 1;\n"),
        _file("acme-svc-abc/../escape.py", b"bad\n"),
        _file("acme-svc-abc/big.bin", b"x" * 2000),
        (link, None),
    ])

    class Res(io.BytesIO):
        def __enter__(self):
            return self

    seen = {}

    def urlopen(req, timeout):
        seen["auth"] = req.get_header("Authorization")
        seen["url"] = req.full_url
        return Res(blob)

    monkeypatch.setattr(github.urllib.request, "urlopen", urlopen)
    dest = tmp_path / "out" / "svc"
    counts = github.download_tree("acme/svc", SHA1, "github_pat_x", dest, max_file_bytes=1000)

    written = sorted(str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file())
    assert written == ["app.py", "src/util.js"]
    assert counts["files"] == 2 and counts["skipped"] == 2
    assert not (tmp_path / "out" / "escape.py").exists()
    assert seen["auth"] == "Bearer github_pat_x"
    assert seen["url"].endswith(f"/repos/acme/svc/tarball/{SHA1}")


def test_download_tree_refuses_odd_repo_names(tmp_path):
    with pytest.raises(github.GitHubError):
        github.download_tree("acme/..", SHA1, None, tmp_path / "x", 1000)
    with pytest.raises(github.GitHubError):
        github.download_tree("acme/svc", "main", None, tmp_path / "y", 1000)



# ── Lambda entry points ─────────────────────────────────────────────────────


@pytest.fixture
def lambda_env(plane, fresh_dsn, monkeypatch):
    from code_graph.etl import aws_lambda

    monkeypatch.setattr(aws_lambda, "_settings", {
        "DATABASE_URL": fresh_dsn, "GITHUB_TOKEN_KEY": KEY.hex(), "INDEXER_SECRET": MASTER,
    })
    monkeypatch.setattr(aws_lambda, "_control_ready", False)
    monkeypatch.setattr(aws_lambda, "_database_url", None)
    sent: list[int] = []
    monkeypatch.setattr(aws_lambda, "_send", lambda ids: sent.extend(ids))
    return aws_lambda, sent


def _url_event(method, path, body=b"", headers=None, b64=False):
    import base64

    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method}},
        "headers": headers or {},
        "body": base64.b64encode(body).decode() if b64 else body.decode(),
        "isBase64Encoded": b64,
    }


def test_trigger_handler_routes_function_url_requests(lambda_env, plane):
    aws_lambda, sent = lambda_env
    a = _tenant(plane, "a")
    _connect_repo(plane, a)
    plane.commit()

    assert aws_lambda.trigger_handler(_url_event("GET", "/health"))["statusCode"] == 200
    assert aws_lambda.trigger_handler(_url_event("GET", "/github"))["statusCode"] == 404

    body = _push()
    headers = {"X-GitHub-Event": "push",
               "X-Hub-Signature-256": _sign(signing.webhook_secret(MASTER, a, "svc"), body)}
    res = aws_lambda.trigger_handler(_url_event("POST", "/github", body, headers, b64=True))
    assert res["statusCode"] == 202 and json.loads(res["body"]) == {"queued": 1}
    assert len(sent) == 1


def test_trigger_handler_runs_the_schedule(lambda_env, plane):
    aws_lambda, sent = lambda_env
    a = _tenant(plane, "a")
    _connect_repo(plane, a)
    plane.commit()
    assert aws_lambda.trigger_handler({"source": "schedule"})["queued"] == 1
    assert len(sent) == 1


def test_worker_handler_runs_sqs_records(lambda_env, plane, fake_github, tmp_path, monkeypatch):
    aws_lambda, _ = lambda_env
    monkeypatch.setenv("SCRATCH_DIR", str(tmp_path))
    a = _tenant(plane, "a")
    _connect_repo(plane, a)
    job = jobs.enqueue(plane, a, "svc", "manual")
    plane.commit()
    out = aws_lambda.worker_handler({"Records": [{"body": json.dumps({"job_id": job})}]})
    assert [r["status"] for r in out["results"]] == ["succeeded"]


def test_database_url_pins_the_ca_when_given(monkeypatch, tmp_path):
    from code_graph.etl import aws_lambda

    monkeypatch.setenv("SCRATCH_DIR", str(tmp_path))
    monkeypatch.setattr(aws_lambda, "_database_url", None)
    monkeypatch.setattr(aws_lambda, "_settings", {
        "DATABASE_URL": "postgresql://u:p@db.example:5432/postgres?sslmode=require",
        "DATABASE_CA_CERT": "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----",
    })
    url = aws_lambda.database_url()
    assert "sslmode=verify-full" in url and f"sslrootcert={tmp_path}" in url
    assert (tmp_path / "database-ca.pem").read_text().splitlines()[1] == "abc"
