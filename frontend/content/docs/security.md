## What CodeGraph stores

| Stored | Not stored |
|---|---|
| File paths and content hashes | File contents |
| Symbol names, kinds, qualified names, line ranges, signatures | Function bodies or any other source text |
| Relationships: imports, calls, inheritance, type use, nesting | Comments, strings, secrets in code |
| The raw text of unresolved references, for example `con.close` | |
| Per repository: its name, indexed path and when it was indexed | |

Source text is never written to the database. When you open a symbol in the explorer or call `get_code_snippet`, the lines are read at that moment, from your disk when self-hosted or from GitHub when hosted. The indexer only parses files. It never builds, installs or runs anything in a repository.

## Self-hosted deployment

Compose publishes every service on `127.0.0.1`, so nothing is reachable from other machines.

The MCP server wants `CODE_GRAPH_TOKEN` on `/mcp` and on its file-preview routes, compared in constant time. The only open route is `/healthz`, and all it reports is `{"status":"ok"}`. Compose won't even start the server without a token.

Repositories are mounted read-only at `/workspaces`, and every path that comes in through a tool argument is confined to that mount (and to the repository's own directory, for previews). Paths that try to escape are refused.

The container runs as an unprivileged user with a read-only root filesystem, no privilege escalation and a 500 MiB memory limit. Neither the indexer nor the MCP server makes outbound network calls.

There's also an optional ngrok tunnel for connecting a hosted app to a self-hosted MCP server. It's off unless you start it (`docker compose --profile tunnel up -d`), and the same token guards everything behind it.

## Hosted deployment

### Signing in

People sign in with GitHub at `/login`. GitHub is only asked who they are (`read:user`, `user:email`), never for repository access, and a new account can't see anything until the administrator approves it. The owner also has a break-glass password login, `OWNER_PASSWORD`, which must pass the same strength rules as any password and is always followed by a TOTP code.

Two-factor authentication uses TOTP authenticator apps, with ten single-use backup codes. It's required for anything administrative: an admin whose session hasn't passed 2FA is treated as a regular user. A code can't be used twice.

A successful sign-in creates a server-side session and sets a signed cookie that only names it: `HttpOnly`, `SameSite=Strict`, `Secure` in production, and valid for seven days. The app re-reads the session on every request, so signing out, suspending an account or "sign out other sessions" takes effect immediately. Nothing about the session is kept in `localStorage`.

Sign-in is rate limited: five attempts per 15 minutes per IP, a CAPTCHA after three failures (when Turnstile is configured), and a lockout with growing waits after that. Every attempt, success or failure, is written to an append-only audit table.

Every page and graph route needs a valid session, except the public site, the docs, `/login`, the health check and the MCP endpoint. That check runs on the server before the page is rendered, and admin routes check again on their own.

### MCP tokens

A token is 256 random bits with a `cgk_` prefix. It's shown once, when it's created, and the database only keeps its SHA-256 hash.

Each token belongs to exactly one graph. The token alone decides which graph a request reads, and no tool argument can name another one.

The administrator issues and revokes tokens. A revoked token stops working on the next request, and every token records when it was last used.

### Isolation between graphs

Each graph is its own Postgres schema. The app picks the schema from the session or the token, checks the name against a strict pattern, and qualifies every query with it.

That isolation is enforced by the application, though. The app's database role can read every graph schema. Per-graph database roles, so that a buggy query would fail instead of reading another graph, are planned hardening.

### The database

The app connects server-side only, over TLS that's verified against the database provider's certificate authority, and verification is never turned off.

Supabase's browser-facing roles (`anon`, `authenticated`) are revoked on every CodeGraph schema, so the Supabase client API can't read the graphs. The app's own database role is read-only, apart from recording when a token was last used.

### Source previews

The browser only ever names a repository within its own graph. The server looks up which GitHub repository that maps to, from the graph's own connection record, and fetches the file with the app's credentials. So a browser can't point the app at some other repository.
