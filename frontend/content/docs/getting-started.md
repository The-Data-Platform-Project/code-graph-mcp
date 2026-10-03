This guide gets ContextForge running on your own machine with Docker, indexes one repository, and opens it in the graph explorer and in Claude Code. It takes about fifteen minutes, and most of that is the first image build.

## Two ways ContextForge runs

| | Self-hosted (this guide) | Hosted |
|---|---|---|
| What runs | Postgres, the MCP server (indexer and tools), and the web app, in Docker Compose | The web app on Vercel, reading a graph in Supabase |
| Indexing | Yes, with the `index_repository` and `reindex_repository` MCP tools | No. It serves graphs that were indexed in a self-hosted stack and loaded by an administrator. |
| Where source comes from | Your disk, mounted read-only | GitHub, fetched on request for previews |
| Who can use it | You, on `127.0.0.1` | The owner, after signing in |

Right now self-hosting is the only way to index a repository. Signing in, connecting GitHub and indexing in the cloud are on the [roadmap](/roadmap), not built yet.

## Prerequisites

You'll need Docker with Docker Compose v2 (on Windows, run Docker inside WSL2), a directory that holds the repositories you want to index, and `openssl` to generate a few secrets. The directory gets mounted read-only. Claude Code is optional, but it's the easiest way to query the graph once it's built.

## 1. Get the code

```bash
git clone https://github.com/The-Data-Platform-Project/code-graph-mcp.git
cd code-graph-mcp
```

## 2. Configure `.env`

```bash
cp .env.example .env
```

Then set these values. Compose won't start if any of the required ones are missing.

| Variable | Value |
|---|---|
| `REPOS_HOST_PATH` | The parent directory of your repositories, for example `/home/you/src`. Mounted read-only at `/workspaces`. |
| `POSTGRES_PASSWORD` | Any password for the local database. |
| `CODE_GRAPH_TOKEN` | A shared secret for the MCP server: `openssl rand -hex 32`. |
| `OWNER_PASSWORD` | The password you'll type to sign in to the web app. At least 12 characters. |
| `SESSION_SECRET` | Signs the sign-in cookie: `openssl rand -hex 32`. At least 32 characters. |
| `GRAPH_SCHEMA` | `tenant_owner`. The web app reads each graph from a tenant schema, so the indexer has to write there too. |

You can leave the ngrok settings empty. The tunnel is opt-in and you don't need it here.

## 3. Start the database

```bash
docker compose up -d postgres
```

## 4. Create your graph's tenant (once)

The web app looks up whose graph to show in a small control schema. This one-off command creates that schema and the `owner` tenant with its empty graph tables.

***Note: run this before you start the MCP server. With `GRAPH_SCHEMA=tenant_owner` set, the server expects that schema to exist when it starts, and it will keep restarting until it does.***

```bash
docker compose run --rm -T code-graph-mcp python - <<'PY'
import os, psycopg
from psycopg.rows import dict_row
from code_graph import control
with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as con:
    with con.transaction():
        control.ensure_control(con)
        _, schema = control.upsert_tenant(con, "owner", "Owner")
        control.ensure_tenant_schema(con, schema)
print("ready:", schema)
PY
```

It prints `ready: tenant_owner`, and running it again is harmless.

## 5. Start everything

```bash
docker compose up -d
docker compose ps
```

You should see three services report `Up (healthy)`:

| Service | Address | Role |
|---|---|---|
| `postgres` | `127.0.0.1:5432` | The graph: structure only, never source text |
| `code-graph-mcp` | `127.0.0.1:8765` | Indexer, MCP tools, and source reads from `/workspaces` |
| `app` | `127.0.0.1:3000` | The web app: graph explorer and docs |

Everything binds to `127.0.0.1`, so nothing is reachable from other machines.

## 6. Connect Claude Code

The repository ships with a `.mcp.json`:

```json
{
  "mcpServers": {
    "code-graph": {
      "type": "http",
      "url": "${CODE_GRAPH_MCP_URL:-http://127.0.0.1:8765/mcp}",
      "headers": { "Authorization": "Bearer ${CODE_GRAPH_TOKEN}" }
    }
  }
}
```

***Note: Claude Code fills in `${CODE_GRAPH_TOKEN}` from its own environment, not from `.env`.*** So export the same value where Claude Code runs, then restart it:

```bash
export CODE_GRAPH_TOKEN="$(sed -n 's/^CODE_GRAPH_TOKEN=//p' .env)"
```

If Claude Code runs on the Windows side, use `setx CODE_GRAPH_TOKEN "<the value from .env>"` instead.

Now open Claude Code in the repository, approve the project MCP server when it asks, and run `/mcp`. You should see `code-graph` with nine tools.

## 7. Index a repository

Ask Claude Code to call the tool, or call it yourself. `path` is relative to `REPOS_HOST_PATH`.

```text
index_repository(name="my-service", path="my-service")
```

You get back a summary of what was indexed. This one is a real run over the ContextForge repository itself:

```json
{ "repo": "code-graph-mcp", "status": "indexed", "files_indexed": 120, "files_skipped": 1, "files_deleted": 0, "nodes": 635, "edges": 3663 }
```

`files_skipped` counts files that were too large (over `MAX_FILE_BYTES`, 1.5 MB by default) or couldn't be read. One bad file never stops an index. Then check the repository is there:

```text
list_repositories()
```

## 8. Open the explorer

Go to `http://127.0.0.1:3000/graph`, sign in with `OWNER_PASSWORD`, and pick your repository from the list. The [explorer guide](/docs/explorer) walks through what you're looking at.

## Keeping the graph current

Once the code changes, re-index incrementally. Only files whose content changed get parsed again:

```text
reindex_repository(name="my-service")
```

```json
{ "repo": "code-graph-mcp", "status": "reindexed", "files_indexed": 46, "files_skipped": 1, "files_deleted": 2, "nodes": 589, "edges": 3505 }
```

That example is a real re-index of the ContextForge repository too. Re-indexing is on demand, nothing watches your files, so run it after you pull or edit.

## Next steps

The [user guide](/docs/user-guide) covers everything ContextForge does end to end, [working with AI agents](/docs/agents) has real example workflows in Claude Code, and if a step above failed, [troubleshooting](/docs/troubleshooting) is the place to look.
