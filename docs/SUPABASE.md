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

### 1. Get the connection strings — and avoid the IPv6 trap

In Supabase: **Connect** (top bar) or **Project Settings → Database**. You are
offered three forms, and picking the wrong one fails in a way that looks like a
firewall problem.

**`db.<ref>.supabase.co` is IPv6-only.** Supabase stopped handing out IPv4
addresses for the direct connection; an IPv4 address is a paid add-on. Docker's
default bridge network is IPv4-only, so a container that dials the direct host
gets "network unreachable" or a hang, with nothing in the Supabase logs. Check
before you debug anything else:

```bash
getent ahostsv4 db.<ref>.supabase.co   # silence means IPv6-only
getent ahostsv6 db.<ref>.supabase.co
```

So use the **pooler** for both jobs. It is IPv4, and it comes in two ports:

| Use | Form | Port | Why |
|---|---|---|---|
| Indexing (this stack) | Session pooler | `5432` | A real session: long transactions and batched writes behave normally. |
| Vercel | Transaction pooler | `6543` | A connection per statement, so many short-lived function instances do not exhaust the limit. |

Both live on `aws-<n>-<region>.pooler.supabase.com` — copy the exact host from
the dashboard, since the region is part of it.

**The username differs.** Direct connections use `postgres`; pooler connections
use `postgres.<project-ref>`. Getting this wrong gives an authentication
failure that reads like a wrong password:

```
# direct  (IPv6 only — usually unreachable from Docker)
postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres

# session pooler — use this for indexing
postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres

# transaction pooler — use this on Vercel
postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Append `?sslmode=require` to each. If your password contains `@`, `:`, `/` or
`#`, percent-encode it or the URI will parse wrongly.

Check the connection before changing anything else — it names the specific
failure rather than hanging:

```bash
DATABASE_URL='postgresql://...' python scripts/check_db.py
```

### 2. Create the schema

```bash
./scripts/setup_db.sh --supabase
```

It prompts for the password (never echoed, never in argv or shell history),
applies the schema, verifies every table landed, and offers to write
`DATABASE_URL` into `.env`. Re-running is safe — every statement is
`CREATE ... IF NOT EXISTS`. The SQL is read out of
[`src/code_graph/db.py`](../src/code_graph/db.py) rather than copied, so the
script cannot drift from what the service expects.

`--docker` targets the local compose container instead; `--host/--port/--user/--db`
reach any other Postgres.

The service also creates its tables on first connect, so this step is strictly a
convenience — it just fails loudly and early instead of at first index.

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
# in .env, point the stack at Supabase (session pooler, port 5432)
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require

wsl -e bash -lc "cd '/mnt/f/The Data Platform Project/Code Graph/code-graph-mcp' && docker compose up -d"
# then re-run index_repository for each repo, from Claude Code or scripts/index_one.py
```

If you would rather move the rows than re-parse them, and you only have the
Postgres client tools inside the container:

```bash
./scripts/push_to_supabase.sh
```

Everything runs inside the `postgres` container — `pg_dump` piped straight into
`psql` against Supabase — so the host needs no Postgres client at all. The
password goes in over stdin, never in argv.

With no `--local-db` it finds the database in that container that actually
holds the graph tables, rather than assuming a name — and stops with the list
it found if there is none, or more than one.

It **replaces** the five graph tables on the target: `nodes` and `edges` are
keyed on a serial id rather than on qualified name, so appending a second copy
would duplicate every node instead of updating it. The truncate and the reload
run in **one transaction**, so a failure part-way leaves the target exactly as
it was. It refuses outright if the source graph is empty (pass `--allow-empty`
if wiping the target really is the intent), dumps to a file and checks the exit
status rather than piping — `sh` has no `pipefail`, so a failing `pg_dump` on
the left of a pipe looks like success — fast-forwards the id sequences that a
data-only restore leaves at 1, and compares row counts per table before
reporting success.

Or by hand, if you prefer:

```bash
pg_dump --no-owner --no-acl \
  "postgresql://codegraph:<pw>@127.0.0.1:5432/codegraph" \
  | psql "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

### 4. Point the app at it

**Local compose** — in `.env`:

```bash
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

and drop the `postgres` service from `docker-compose.yml` (or leave it running
and unused; it costs a little memory and nothing else).

**Vercel** — in Project Settings → Environment Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **transaction pooler** URI (port `6543`, user `postgres.<ref>`), plus `?sslmode=require` |
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
