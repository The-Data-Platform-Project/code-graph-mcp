# Moving Postgres to Supabase

The compose stack runs Postgres as a local container. Nothing about the code
assumes that — the graph is reached through one `DATABASE_URL` — so moving to
Supabase is a connection-string change plus the operational details below.

## Why you would

Today the database is only reachable on the compose network and on
`127.0.0.1`. That is fine for the local app, but a Vercel deployment cannot
open a socket to your machine, so the hosted app falls back to reading the
graph through the tunnel (`GRAPH_SOURCE=mcp`). Every graph query then needs
your machine awake and the tunnel up.

With the graph in Supabase:

- Vercel reads the graph directly, so browsing stays fast and works whether or
  not your machine is on.
- Your machine is needed only for **indexing** and for **source previews** —
  the two things that genuinely require the repositories on disk.

The tunnel does not go away. It gets much less traffic.

## What moves, and what cannot

| | Where it lives after the move |
|---|---|
| `repos`, `nodes`, `edges`, `files`, `imports` | Supabase |
| Indexing (tree-sitter parsing, resolution) | still your machine — it reads the repos |
| README / file / symbol source text | still your machine — the DB never stores source |

The last row is the important one: this project stores **structure only**, so
no amount of hosting removes the need for the container when you want to look
at actual code.

## Steps

### 1. Create the project and get the connection string

In Supabase: **New project**, then **Project Settings → Database → Connection
string → URI**. You get two forms, and the difference matters:

- **Direct connection** (port `5432`) — a real Postgres connection. Use this
  for **indexing**, which runs long transactions and batches writes.
- **Transaction pooler** (port `6543`, host contains `pooler`) — PgBouncer in
  transaction mode. Use this for **Vercel**, where many short-lived function
  instances each want a connection.

Using the direct port from Vercel will exhaust the connection limit; using the
pooler for indexing breaks on session-level features. Set both.

### 2. Create the schema

The service creates its own tables on first connect, so the simplest path is to
point the indexer at Supabase once and let it run. If you would rather apply
the schema explicitly, it is the `_SCHEMA` constant in
[`src/code_graph/db.py`](../src/code_graph/db.py) — paste it into the Supabase
SQL editor.

Either way, verify:

```sql
select table_name from information_schema.columns
 where table_schema = 'public' group by table_name;
-- expect: edges, files, imports, nodes, repos
```

### 3. Re-index into it

The graph is derived data — there is nothing to migrate. Re-indexing is
cleaner than dumping and restoring, and it is fast:

```bash
# in .env, point the stack at Supabase (direct connection, port 5432)
DATABASE_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres

wsl -e bash -lc "cd '/mnt/f/Code Graph/code-graph-mcp' && docker compose up -d"
# then re-run index_repository for each repo, from Claude Code or scripts/index_one.py
```

If you would rather move the rows than re-parse them:

```bash
pg_dump --no-owner --no-acl \
  "postgresql://codegraph:<pw>@127.0.0.1:5432/codegraph" \
  | psql "postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres"
```

### 4. Point the app at it

**Local compose** — in `.env`:

```bash
DATABASE_URL=postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres
```

and drop the `postgres` service from `docker-compose.yml` (or leave it running
and unused; it costs a little memory and nothing else).

**Vercel** — in Project Settings → Environment Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **pooler** URI (port `6543`), plus `?sslmode=require` |
| `GRAPH_SOURCE` | `postgres` |
| `MCP_BASE_URL` | your ngrok URL — still needed for source previews |
| `CODE_GRAPH_TOKEN` | the same token as in `.env` |
| `PGPOOL_MAX` | `1` — see below |

Set `PGPOOL_MAX=1` on Vercel. Each serverless instance keeps its own pool, so a
`max` of 3 across many concurrent instances multiplies quickly; behind the
transaction pooler, one connection per instance is the right shape.

## Security: the graph is not source code, but it is not nothing

The database holds file paths, symbol names, signatures and the call graph of
your private repositories. That is a meaningful disclosure on its own — it maps
your architecture. Treat the Supabase project as private:

- **Do not enable the anon/public API for these tables.** The app connects with
  the Postgres role, server-side. Nothing in the browser ever holds a database
  credential.
- If you enable Row Level Security, note that the service role bypasses it;
  RLS buys you little here and can silently break indexing. Keeping the tables
  out of the exposed schema entirely is the stronger control — in **Project
  Settings → API → Exposed schemas**, remove `public` if you do not use
  PostgREST for anything else.
- Rotate `CODE_GRAPH_TOKEN` and the database password together; the token is
  what protects the far more sensitive surface, which is `/api/file` reading
  your actual source.

## Cost and limits worth knowing

- The free tier pauses a project after a week of inactivity. A paused database
  means the hosted app shows an error until you resume it.
- Free-tier storage is 500 MB. As a reference point, this repository indexes to
  roughly 340 nodes and 2,000 edges; the Python standard library (732 files)
  produces about 19k nodes and 75k edges. Even a large monorepo is unlikely to
  approach the limit, because no source text is stored.
- The transaction pooler does not support `LISTEN`/`NOTIFY` or prepared
  statements across transactions. Nothing here uses either.

## Rolling back

Put the original `DATABASE_URL` back in `.env` and restart. Nothing else in the
codebase changes, and the local Postgres volume still has the previous graph
unless you deleted it.
