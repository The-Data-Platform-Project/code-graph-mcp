Each entry starts with the symptom as you'll see it, then the cause and the fix. Most of these apply to the self-hosted stack, and the last section covers the hosted deployment.

## Starting the stack

### `required variable … is missing a value`

Compose checks every service's required settings before it runs any command, even one that only touches the database. So set all of `POSTGRES_PASSWORD`, `CODE_GRAPH_TOKEN`, `OWNER_PASSWORD` and `SESSION_SECRET` in `.env` (see [getting started](/docs/getting-started#2-configure-env)).

### `code-graph-mcp` keeps restarting and its logs say `no schema has been selected to create in`

You've set `GRAPH_SCHEMA=tenant_owner`, but that schema doesn't exist yet, and the server checks its tables at startup. Create the tenant first ([step 4](/docs/getting-started#4-create-your-graphs-tenant-once)), then:

```bash
docker compose up -d
```

### `ImportError: cannot import name 'control'`

Your `code-graph-mcp` image was built from an older version. Rebuild it:

```bash
docker compose build code-graph-mcp
docker compose up -d
```

### Checking the database connection

From a Python environment with the project's dependencies (`pip install -r requirements.lock.txt`), and with `DATABASE_URL` set to the database:

```bash
python scripts/check_db.py
```

It reports the host, whether it resolves and whether the graph tables exist, and names the likely cause if something fails.

## The explorer

### "Could not load the graph"

The app either can't reach the database or can't find your tenant. Check the app's logs:

```bash
docker compose logs --tail 50 app
```

If it can't find tenant `owner`, run the tenant command from [getting started](/docs/getting-started#4-create-your-graphs-tenant-once).

### "No nodes to display"

Either your filters are hiding everything (turn the node types back on and clear the search), or nothing was indexed into the schema the app reads. If you indexed before setting `GRAPH_SCHEMA=tenant_owner`, the graph went into the `public` schema. Set it, restart with `docker compose up -d`, and index again.

### Signing in fails, or pages error after signing in

"That password is not right" means it doesn't match `OWNER_PASSWORD` in `.env` exactly. If you changed `.env`, restart the app with `docker compose up -d`.

"Sign-in is not set up on this deployment" means `OWNER_PASSWORD` or `SESSION_SECRET` is missing, or too short. The server log says which one.

Server errors with logs saying "must be at least" mean `OWNER_PASSWORD` is shorter than 12 characters or `SESSION_SECRET` is shorter than 32.

If you keep getting sent back to the sign-in page, your session expired (they last seven days), or `SESSION_SECRET` changed, which signs everyone out.

### "Source unavailable" in the preview panel

The graph loaded but the file couldn't be read. Self-hosted, the repository's directory may have moved, or the MCP container is down (`docker compose ps`). Hosted, the repository has no GitHub connection, or the connection's token can't see a private repository.

### Snippets show the wrong lines

The file changed after it was indexed. Re-index it:

```text
reindex_repository(name="my-service")
```

## Claude Code and MCP

### `code-graph` is missing from `/mcp`

Open Claude Code in the repository that has `.mcp.json`, approve the project MCP server when it asks, and restart Claude Code after changing environment variables.

### Every tool call fails with 401

Claude Code sends `CODE_GRAPH_TOKEN` from its own environment. So set it where Claude Code runs (use `setx` on Windows), to the value in `.env` for self-hosted or your `cgk_…` token for hosted, then restart Claude Code.

### `not a directory under /workspaces`

The `path` in `index_repository` is relative to `REPOS_HOST_PATH`, not an absolute path on your machine. If `REPOS_HOST_PATH=/home/you/src` and the repository is `/home/you/src/api`, use `path="api"`.

### `invalid repo name`

Names can only use letters, digits, `.`, `_` and `-`.

### `repo '…' is not indexed; call index_repository first`

`reindex_repository` only works on a name that's already indexed. Check the names with `list_repositories()`.

### Results mention unresolved

That's expected, not an error. The call leaves the repository (a library), or its target is ambiguous. See [resolved and unresolved](/docs/user-guide#resolved-and-unresolved).

## Hosted deployment

### Checking a deployment

`tests/diagnostics/smoke_prod.sh` checks a deployment without signing in. It hits the health check, the public pages, the sign-in redirect, and makes sure the MCP endpoint rejects a missing token and a fake one. Rejecting the fake one needs a database lookup, so a pass also tells you the database connection works. If anything fails, it prints the server's recent errors.

```bash
tests/diagnostics/smoke_prod.sh https://<your-deployment>
```

### Claude Code gets a sign-in page from the MCP endpoint

That's Vercel's deployment protection on a preview URL. Use the production URL for MCP.
