This guide runs ContextForge on your own machine with Docker, indexes one repository, and opens it in the graph explorer and in Claude Code. Expect about fifteen minutes, most of it the first image build.

## Two ways ContextForge runs

| | Self-hosted (this guide) | Hosted |
|---|---|---|
| What runs | Postgres, the MCP server (indexer and tools), and the web app, in Docker Compose | The web app on Vercel, reading a graph in Supabase |
| Indexing | Yes, with the `index_repository` and `reindex_repository` MCP tools | No. It serves graphs that were indexed in a self-hosted stack and loaded by an administrator. |
| Where source comes from | Your disk, mounted read-only | GitHub, fetched on request for previews |
| Who can use it | You, on `127.0.0.1` | The owner, after signing in |

Self-hosting is the only way to index repositories today. Hosted onboarding (sign in, connect GitHub, index in the cloud) is on the [roadmap](/roadmap).

## Prerequisites

- **Docker** with **Docker Compose** v2. On Windows, run Docker inside WSL2.
- A directory that contains the repositories you want to index. It is mounted read-only.
- `openssl`, to generate secrets.
- Optional: **Claude Code**, to query the graph from your editor.

## 1. Get the code

```bash
git clone https://github.com/The-Data-Platform-Project/code-graph-mcp.git
cd code-graph-mcp
```

## 2. Configure `.env`

```bash
cp .env.example .env
```

Set these values. Compose refuses to start if any required one is missing.

| Variable | Value |
|---|---|
| `REPOS_HOST_PATH` | The parent directory of your repositories, for example `/home/you/src`. Mounted read-only at `/workspaces`. |
| `POSTGRES_PASSWORD` | Any password for the local database. |
| `CODE_GRAPH_TOKEN` | A shared secret for the MCP server: `openssl rand -hex 32`. |
| `OWNER_PASSWORD` | The password you will type to sign in to the web app. At least 12 characters. |
| `SESSION_SECRET` | Signs the sign-in cookie: `openssl rand -hex 32`. At least 32 characters. |
| `GRAPH_SCHEMA` | `tenant_owner`. The web app reads each graph from a tenant schema, so the indexer must write there too. |

Leave the ngrok settings empty; the tunnel is opt-in and not needed here.

## 3. Start the database

```bash
docker compose up -d postgres
```

## 4. Create your graph's tenant (once)

The web app looks up whose graph to show in a small control schema. This one-off command creates that schema and the `owner` tenant with its empty graph tables. Run it before starting the MCP server: with `GRAPH_SCHEMA=tenant_owner`, the server expects that schema to exist when it starts.

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

It prints `ready: tenant_owner`. Running it again is harmless.

## 5. Start everything

```bash
docker compose up -d
docker compose ps
```

Three services should report `Up (healthy)`:

| Service | Address | Role |
|---|---|---|
| `postgres` | `127.0.0.1:5432` | The graph: structure only, never source text |
| `code-graph-mcp` | `127.0.0.1:8765` | Indexer, MCP tools, and source reads from `/workspaces` |
| `app` | `127.0.0.1:3000` | The web app: graph explorer and docs |

Everything binds to `127.0.0.1`, so nothing is reachable from other machines.

## 6. Connect Claude Code

The repository includes `.mcp.json`:

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

Claude Code expands `${CODE_GRAPH_TOKEN}` from **its own environment**, not from `.env`. Export the same value where Claude Code runs, then restart it:

```bash
export CODE_GRAPH_TOKEN="$(sed -n 's/^CODE_GRAPH_TOKEN=//p' .env)"
```

On Windows with Claude Code on the Windows side, set it with `setx CODE_GRAPH_TOKEN "<the value from .env>"` instead.

Open Claude Code in the repository, approve the project MCP server, and run `/mcp`. You should see `code-graph` with nine tools.

## 7. Index a repository

Ask Claude Code to call the tool, or call it yourself. `path` is relative to `REPOS_HOST_PATH`.

```text
index_repository(name="my-service", path="my-service")
```

The result reports what was indexed. This is a real run over the ContextForge repository itself:

```json
{ "repo": "code-graph-mcp", "status": "indexed", "files_indexed": 120, "files_skipped": 1, "files_deleted": 0, "nodes": 635, "edges": 3663 }
```

`files_skipped` counts files that were too large (over `MAX_FILE_BYTES`, 1.5 MB by default) or unreadable. One bad file never stops an index. Then confirm the repository is there:

```text
list_repositories()
```

## 8. Open the explorer

Go to `http://127.0.0.1:3000/graph`, sign in with `OWNER_PASSWORD`, and choose your repository from the list. The [explorer guide](/docs/explorer) explains what you are looking at.

## Keeping the graph current

After the code changes, re-index incrementally. Only files whose content changed are re-parsed:

```text
reindex_repository(name="my-service")
```

```json
{ "repo": "my-service", "status": "reindexed", "files_indexed": 46, "files_skipped": 1, "files_deleted": 2, "nodes": 589, "edges": 3505 }
```

That example is a real re-index of the ContextForge repository itself. Re-indexing is on demand: nothing watches your files.

## Next steps

- [User guide](/docs/user-guide): everything ContextForge does, end to end.
- [Working with AI agents](/docs/agents): example workflows in Claude Code.
- [Troubleshooting](/docs/troubleshooting): if a step above failed.
