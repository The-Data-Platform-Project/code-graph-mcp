"""Encryption at rest for secrets the app must read back: GitHub tokens.

A GitHub token cannot be hashed like an MCP token — the app and the indexer
both need the plaintext to call GitHub — so it is sealed with AES-256-GCM under
`GITHUB_TOKEN_KEY` (64 hex characters: `openssl rand -hex 32`), which lives in
the app's and the indexer's environment, never in the database.

Wire format, shared byte-for-byte with frontend/lib/secretbox.ts:

    v1.<base64url 12-byte nonce>.<base64url ciphertext || 16-byte tag>

The additional authenticated data names what the secret is for and which
tenant owns it, so a ciphertext copied onto another tenant's row fails to open
rather than handing that tenant someone else's token.
"""

from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VERSION = "v1"


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def parse_key(hex_key: str) -> bytes:
    key = bytes.fromhex((hex_key or "").strip())
    if len(key) != 32:
        raise ValueError("GITHUB_TOKEN_KEY must be 64 hex characters (openssl rand -hex 32)")
    return key


def token_aad(tenant_id: int) -> bytes:
    return f"github_token:{int(tenant_id)}".encode("ascii")


def seal(key: bytes, plaintext: str, aad: bytes) -> str:
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plaintext.encode("utf-8"), aad)
    return f"{VERSION}.{_b64e(nonce)}.{_b64e(ct)}"


def open_sealed(key: bytes, sealed: str, aad: bytes) -> str:
    """The plaintext, or ValueError if the value is malformed or was tampered with."""
    parts = (sealed or "").split(".")
    if len(parts) != 3 or parts[0] != VERSION:
        raise ValueError("not a sealed v1 secret")
    try:
        return AESGCM(key).decrypt(_b64d(parts[1]), _b64d(parts[2]), aad).decode("utf-8")
    except Exception as exc:  # InvalidTag, bad base64, bad nonce length
        raise ValueError("sealed secret failed authentication") from exc
