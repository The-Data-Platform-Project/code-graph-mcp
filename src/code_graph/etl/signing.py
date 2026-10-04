"""Authenticating the two kinds of request that can start an index job.

One master secret (`INDEXER_SECRET`, shared by the web app and the indexer)
derives everything, with a distinct label per use so no derived value can stand
in for another:

- **GitHub webhooks.** Each repo connection gets its own webhook secret,
  `HMAC(master, "webhook:<tenant_id>:<repo_name>")`. GitHub signs every
  delivery with it (`X-Hub-Signature-256`). A tenant who sees their own secret
  in the app cannot forge a push for anyone else's connection, and nothing per
  connection has to be stored. frontend/lib/indexer.ts derives the same value.
- **The web app** ("Index now"). Requests carry `X-CG-Timestamp` and
  `X-CG-Signature: v1=HMAC(master, "enqueue:<timestamp>.<body>")`; anything
  older than five minutes is refused, so a captured request cannot be replayed
  later.
"""

from __future__ import annotations

import hashlib
import hmac
import time

MAX_SKEW_SECONDS = 300


def _hmac_hex(key: str, message: str) -> str:
    return hmac.new(key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def webhook_secret(master: str, tenant_id: int, repo_name: str) -> str:
    return _hmac_hex(master, f"webhook:{int(tenant_id)}:{repo_name}")


def verify_github_signature(secret: str, body: bytes, header: str | None) -> bool:
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256="):])


def sign_app_request(master: str, timestamp: int, body: str) -> str:
    return "v1=" + _hmac_hex(master, f"enqueue:{timestamp}.{body}")


def verify_app_request(
    master: str, body: str, timestamp: str | None, signature: str | None,
    now: float | None = None,
) -> bool:
    if not timestamp or not signature:
        return False
    try:
        ts = int(timestamp)
    except ValueError:
        return False
    if abs((now if now is not None else time.time()) - ts) > MAX_SKEW_SECONDS:
        return False
    return hmac.compare_digest(sign_app_request(master, ts, body), signature)
