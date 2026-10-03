## What ContextForge stores

| Stored | Not stored |
|---|---|
| File paths and content hashes | File contents |
| Symbol names, kinds, qualified names, line ranges, signatures | Function bodies or any other source text |
| Relationships: imports, calls, inheritance, type use, nesting | Comments, strings, secrets in code |
| The raw text of unresolved references, for example `con.close` | |
| Per repository: its name, indexed path and when it was indexed | |

**Source text is never written to the database.** When you open a symbol in the explorer or call `get_code_snippet`, the lines are read at that moment: from your disk (self-hosted) or from GitHub (hosted). The indexer only **parses** files. It never builds, installs or runs anything in a repository.

## Self-hosted deployment

- **Loopback only.** Compose publishes every service on `127.0.0.1`; nothing is reachable from other machines.
- **A token on everything.** The MCP server requires `CODE_GRAPH_TOKEN` on `/mcp` and on its file-preview routes, compared in constant time. Only `/healthz` is open, and it reports nothing but `{"status":"ok"}`. Compose refuses to start the server without a token.
- **Read-only source.** Repositories are mounted read-only at `/workspaces`, and every path from a tool argument is confined to that mount (a repository's own directory, for previews). Paths that escape are refused.
- **A hardened container.** An unprivileged user, a read-only root filesystem, no privilege escalation, and a 500 MiB memory limit.
- **No egress.** The indexer and MCP server make no outbound network calls.
- **Optional tunnel.** An ngrok tunnel exists for connecting a hosted app to a self-hosted MCP server. It is off unless you start it (`docker compose --profile tunnel up -d`), and the same token guards everything behind it.

## Hosted deployment

### Signing in

- Today there is one account, the **owner**, who signs in with `OWNER_PASSWORD` at `/login`. The comparison runs in constant time, and each failed attempt waits before answering.
- Success sets a signed session cookie (HMAC-SHA256): `HttpOnly`, `SameSite=Lax`, `Secure` in production, valid for seven days. Signing out clears it.
- Every page and graph route except the public site, the docs, `/login`, the health check and the MCP endpoint requires a valid session. The check runs before the page is rendered.

Sign-in with Google or GitHub, and accounts for other users, are [planned](/roadmap).

### MCP tokens

- A token is 256 random bits with a `cgk_` prefix. It is shown **once**, when created; the database keeps only its SHA-256 hash.
- A token belongs to exactly one graph. It alone decides which graph a request reads, and no tool argument can name another.
- Tokens can be revoked at any time, taking effect on the next request, and record when they were last used.
- Tokens are issued and revoked by the administrator.

### Isolation between graphs

Each graph is its own Postgres schema. The app picks the schema from the session or token, validates its name against a strict pattern, and qualifies every query with it. That isolation is **enforced by the application**: the app's database role can read every graph schema. Per-graph database roles, so that a faulty query would fail rather than read another graph, are planned hardening.

### The database

- The app connects server-side only, over TLS **verified** against the database provider's certificate authority. Verification is never turned off.
- Supabase's browser-facing roles (`anon`, `authenticated`) are revoked on every ContextForge schema, so the Supabase client API cannot read the graphs.
- The app's database role is read-only apart from recording when a token was last used.

### Source previews

The browser only ever names a repository within its own graph. The server looks up which GitHub repository that corresponds to, from the graph's own connection record, and fetches the file with the app's credentials. A browser cannot point the app at any other repository.
