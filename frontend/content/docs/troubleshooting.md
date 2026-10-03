Each entry gives the symptom as you will see it, its cause, and the fix. Most apply to the self-hosted stack; the last section covers the hosted deployment.

## Starting the stack

### `required variable … is missing a value`

Compose checks **every** service's required settings before running **any** command, even one that touches only the database. Set all of `POSTGRES_PASSWORD`, `CODE_GRAPH_TOKEN`, `OWNER_PASSWORD` and `SESSION_SECRET` in `.env` (see [getting started](/docs/getting-started#2-configure-env)).

### `code-graph-mcp` keeps restarting; its logs say `no schema has been selected to create in`

`GRAPH_SCHEMA=tenant_owner` is set, but that schema does not exist yet. The server checks its tables at startup. Create the tenant first ([step 4](/docs/getting-started#4-create-your-graphs-tenant-once)), then:

```bash
docker compose up -d
```

### `ImportError: cannot import name 'control'`

The `code-graph-mcp` image was built from an older version. Rebuild it:

```bash
docker compose build code-graph-mcp
docker compose up -d
```

### Checking the database connection

From a Python environment with the project's dependencies (`pip install -r requirements.lock.txt`), with `DATABASE_URL` set to the database:

```bash
python scripts/check_db.py
```

It reports the host, whether it resolves, and whether the graph tables exist, and names the likely cause of a failure.

## The explorer

### "Could not load the graph"

The app cannot reach the database or cannot find your tenant. Check the app's logs:

```bash
docker compose logs --tail 50 app
```

If it cannot find tenant `owner`, run the tenant command from [getting started](/docs/getting-started#4-create-your-graphs-tenant-once).

### "No nodes to display"

Either your filters hide everything (turn node types back on, clear the search), or nothing has been indexed into the schema the app reads. If you indexed before setting `GRAPH_SCHEMA=tenant_owner`, the graph went to the `public` schema. Set it, restart with `docker compose up -d`, and index again.

### Signing in fails, or every page errors after sign-in

- **"That password is not right."** It must match `OWNER_PASSWORD` in `.env` exactly. After changing `.env`, restart the app with `docker compose up -d`.
- **Server errors, with logs saying "must be at least"**: `OWNER_PASSWORD` is shorter than 12 characters or `SESSION_SECRET` shorter than 32.
- **You are sent back to the sign-in page**: your session expired (after seven days), or `SESSION_SECRET` changed, which signs everyone out.

### "Source unavailable" in the preview panel

The graph loaded but the file could not be read. Self-hosted, the repository's directory may have moved, or the MCP container is down (`docker compose ps`). Hosted, the repository has no GitHub connection, or the connection's token cannot see a private repository.

### Snippets show the wrong lines

The file has changed since it was indexed. Re-index it:

```text
reindex_repository(name="my-service")
```

## Claude Code and MCP

### `code-graph` is missing from `/mcp`

Open Claude Code in the repository that holds `.mcp.json`, approve the project MCP server when prompted, and restart Claude Code after changing environment variables.

### Every tool call fails with 401

Claude Code sends `CODE_GRAPH_TOKEN` from **its own** environment. Set it where Claude Code runs (use `setx` on Windows), to the value in `.env` for self-hosted or your `cgk_…` token for hosted, then restart Claude Code.

### `not a directory under /workspaces`

`path` in `index_repository` is relative to `REPOS_HOST_PATH`, not an absolute path on your machine. If `REPOS_HOST_PATH=/home/you/src` and the repository is `/home/you/src/api`, use `path="api"`.

### `invalid repo name`

Names may use letters, digits, `.`, `_` and `-` only.

### `repo '…' is not indexed; call index_repository first`

`reindex_repository` only works on a name already indexed. Check the names with `list_repositories()`.

### Results mention *unresolved*

This is expected, not an error: the call leaves the repository (a library), or its target is ambiguous. See [resolved and unresolved](/docs/user-guide#resolved-and-unresolved).

## Hosted deployment

### A deployment check

`tests/diagnostics/smoke_prod.sh` checks a deployment without signing in: the health check, the public pages, the sign-in redirect, and that the MCP endpoint rejects missing and fake tokens. Rejecting a fake token needs a database lookup, so a pass also proves the database connection works. If anything fails, it prints the server's recent errors.

```bash
tests/diagnostics/smoke_prod.sh https://<your-deployment>
```

### Claude Code gets a sign-in page from the MCP endpoint

That is Vercel's deployment protection on a preview URL. Use the production URL for MCP.
