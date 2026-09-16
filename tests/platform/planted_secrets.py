"""Credential *shapes* for the secrets-trap fixture, assembled at build time.

Nothing here is a real credential, and — deliberately — nothing here is a
literal one either: each value is joined from fragments so the repository never
contains a string that looks like a token to a scanner (ours, GitHub's push
protection, or anyone else's). The pipeline's redactor must still catch these
once they are written to a working tree.

The AWS pair is the public example pair from AWS's own documentation.
"""

from __future__ import annotations

# --- shapes ---------------------------------------------------------------
AWS_ACCESS_KEY_ID = "AKIA" + "IOSFODNN7" + "EXAMPLE"
AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfi" + "CYEXAMPLEKEY"
GITHUB_TOKEN = "ghp_" + ("0123456789abcdef" * 3)[:36]
SLACK_TOKEN = "xoxb-" + "111111111111-222222222222-" + ("A" * 24)
STRIPE_KEY = "sk_live_" + ("0" * 24)
JWT = ".".join(["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmaXh0dXJlIn0", "c2lnbmF0dXJl"])
PRIVATE_KEY = "\n".join(
    [
        "-----BEGIN RSA PRIVATE" + " KEY-----",
        *["MIIEowIBAAKCAQEAxfixtureonlynotarealkeyxxxxxxxxxxxxxxxxxxxxxxxx" for _ in range(3)],
        "-----END RSA PRIVATE" + " KEY-----",
    ]
)
DB_PASSWORD = "hunter2-" + "fixture"
CONNECTION_STRING = f"postgresql://shop:{DB_PASSWORD}@db.internal.example:5432/shop"


def files() -> dict[str, str]:
    """The secrets-trap working tree, as {repo-relative path: content}."""
    return {
        "README.md": (
            "# secrets-trap\n\n"
            "Every value in this repository is a fake credential in a realistic\n"
            "shape. Indexing must record *names and locations only*: no value\n"
            "here may ever reach the graph.\n"
        ),
        "config.py": (
            '"""Configuration with credentials inlined the way real code does it."""\n\n'
            f'AWS_ACCESS_KEY_ID = "{AWS_ACCESS_KEY_ID}"\n'
            f'AWS_SECRET_ACCESS_KEY = "{AWS_SECRET_ACCESS_KEY}"\n'
            f'GITHUB_TOKEN = "{GITHUB_TOKEN}"\n'
            f'STRIPE_SECRET_KEY = "{STRIPE_KEY}"\n'
            f'DATABASE_URL = "{CONNECTION_STRING}"\n\n\n'
            "def client_headers():\n"
            '    """Build the auth headers used by the API client."""\n'
            f'    return {{"Authorization": "Bearer {JWT}"}}\n'
        ),
        ".env": (
            f"AWS_ACCESS_KEY_ID={AWS_ACCESS_KEY_ID}\n"
            f"AWS_SECRET_ACCESS_KEY={AWS_SECRET_ACCESS_KEY}\n"
            f"SLACK_BOT_TOKEN={SLACK_TOKEN}\n"
            f"DB_PASSWORD={DB_PASSWORD}\n"
        ),
        ".env.example": (
            "AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nSLACK_BOT_TOKEN=\nDB_PASSWORD=\n"
        ),
        "deploy/id_rsa": PRIVATE_KEY + "\n",
        "docker-compose.yml": (
            "services:\n"
            "  db:\n"
            "    image: postgres:16\n"
            "    environment:\n"
            f"      POSTGRES_PASSWORD: {DB_PASSWORD}\n"
        ),
    }


def values() -> tuple[str, ...]:
    """Every planted value, for 'this must not appear anywhere' assertions."""
    return (
        AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY,
        GITHUB_TOKEN,
        SLACK_TOKEN,
        STRIPE_KEY,
        JWT,
        DB_PASSWORD,
        PRIVATE_KEY,
    )
