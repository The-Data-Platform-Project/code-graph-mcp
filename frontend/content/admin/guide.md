## Deployment and infrastructure

### Components

| Component | Self-hosted | Hosted |
|---|---|---|
| Web app (explorer, docs, `/api/mcp`) | `app` service, `127.0.0.1:3000` | Vercel project, Root Directory `frontend`, Next.js |
| MCP server with indexing | `code-graph-mcp` service, `127.0.0.1:8765` | none: the hosted app answers MCP itself (`MCP_BACKEND=native`) |
| Graph database | `postgres` service, or an existing Postgres container | Supabase Postgres |
| Source text for previews | the MCP container reads `/workspaces` | GitHub, through `control.repo_connections` |

The Vercel functions are pinned to one region in `frontend/vercel.json`. Keep that region next to the database's, since every graph query goes over that link.

### Local Docker deployment

The public [getting started guide](/docs/getting-started) has the full procedure. A few things worth knowing when you run it yourself:

You can use an existing Postgres container instead of the stack's own by adding the external-database overlay in `.env`:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.external-db.yml
POSTGRES_HOST=<container-name>
EXTERNAL_DB_NETWORK=<that container's docker network>
```

Create the role and database in that container first:

```bash
./scripts/setup_db.sh --docker <container-name> --create-role
```

A container on another project's network publishes no host port, so host-side tools (pytest, the admin scripts) have to reach it by its IP on that network. `tests/diagnostics/run_tests.sh` works that out for you.

Compose checks every service's required variables before it runs any command, so `.env` needs `POSTGRES_PASSWORD`, `CODE_GRAPH_TOKEN`, `OWNER_PASSWORD` and `SESSION_SECRET` even for a one-off command against a single service.

After pulling new code, rebuild the images with `docker compose build`, then `docker compose up -d`. A stale `code-graph-mcp` image will be missing newer modules like `control`.

### Hosted architecture

```text
  Claude Code ──Bearer cgk_…──► /api/mcp ─┐
                                          ├── Next.js (Vercel) ──► Supabase Postgres (transaction pooler, TLS, CA-verified)
  Browser ──owner sign-in─────► /graph  ──┘                   └──► GitHub API (source text per request)
```

On Vercel, production deploys the `main` branch and every other branch gets a preview deployment. Previews don't have the database secrets or the sign-in password unless you add them to the Preview environment, so on a preview the sign-in page will say sign-in isn't set up.

Supabase gives you two pooler ports, both on IPv4 (the direct `db.<project-ref>.supabase.co` host is IPv6-only, so avoid it). Use the session pooler on port 5432 for the admin scripts, since it supports long transactions. Use the transaction pooler on port 6543 for the Vercel app, which opens a connection per statement and suits serverless instances.

Pooler user names carry the project ref: `postgres.<project-ref>` for administration and `codegraph_app.<project-ref>` for the app. Without the suffix, the pooler answers `Tenant or user not found`.

### Environment variables

For the web app (Vercel, or the `app` service):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://codegraph_app.<project-ref>:<password>@<pooler-host>:6543/postgres` when hosted. URL-encode special characters in the password. |
| `DATABASE_CA_CERT` | hosted | The full PEM of Supabase's CA. A literal `\n` is accepted in place of newlines. |
| `PGPOOL_MAX` | hosted | `1` on Vercel: one connection per function instance. |
| `OWNER_PASSWORD` | yes | The owner's sign-in password, 12 or more characters. |
| `SESSION_SECRET` | yes | Signs session cookies, 32 or more characters (`openssl rand -hex 32`). |
| `OWNER_TENANT_SLUG` | no | The tenant the owner signs in to. Default `owner`. |
| `SOURCE_PROVIDER` | no | `github` (default), `mcp` or `none`. |
| `GITHUB_TOKEN` | hosted | A read-only, fine-grained token with Contents access to the connected repositories. |
| `MCP_BACKEND` | no | `native` (default) or `proxy`. |
| `MCP_UPSTREAM_URL` / `MCP_UPSTREAM_TOKEN` | proxy only | Where `/api/mcp` forwards, and the token it sends. |
| `MCP_BASE_URL` / `CODE_GRAPH_TOKEN` | `SOURCE_PROVIDER=mcp` | The Python MCP server's base URL and token, for reading source. |
| `SITE_URL` | no | The canonical site origin for metadata and the sitemap. Default `https://contextforge.ai`. |

For the self-hosted stack (`.env`):

| Variable | Purpose |
|---|---|
| `REPOS_HOST_PATH` | Parent directory of indexable repositories, mounted read-only at `/workspaces` |
| `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB` | The local graph database (user and database default to `codegraph`) |
| `CODE_GRAPH_TOKEN` | The MCP server's shared secret. Required. |
| `GRAPH_SCHEMA` | The schema the Python server reads and writes: `tenant_owner` for the explorer's layout |
| `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` | Only for the opt-in tunnel profile |
| `COMPOSE_FILE`, `POSTGRES_HOST`, `EXTERNAL_DB_NETWORK` | The external-database overlay (above) |
| `MAX_FILE_BYTES`, `COMMIT_BATCH_FILES` | Indexer limits: 1.5 MB and 200 files by default |

***Note: Claude Code reads `CODE_GRAPH_MCP_URL` and `CODE_GRAPH_TOKEN` from its own environment (`setx` on Windows), not from `.env`.***

### Database configuration

1. Create the schema. The loader creates `control` and the tenant schema itself (see below). For the older single-tenant `public` layout, use `./scripts/setup_db.sh --supabase`.
2. Create the app's read-only role in the Supabase SQL Editor:

   ```sql
   CREATE ROLE codegraph_app LOGIN PASSWORD '<a long random password>';
   GRANT USAGE ON SCHEMA control TO codegraph_app;
   GRANT SELECT ON ALL TABLES IN SCHEMA control TO codegraph_app;
   GRANT UPDATE (last_used_at) ON control.mcp_tokens TO codegraph_app;
   GRANT USAGE ON SCHEMA tenant_owner TO codegraph_app;
   GRANT SELECT ON ALL TABLES IN SCHEMA tenant_owner TO codegraph_app;
   ```

   Repeat the last two lines for every new tenant schema. `--replace` loads keep the grants, because they truncate tables instead of dropping them. To change the password later, run `ALTER ROLE codegraph_app WITH PASSWORD '<new password>';` and update `DATABASE_URL`.
3. Trust the CA. Download the certificate from Supabase (Project Settings → Database → SSL Configuration) into `DATABASE_CA_CERT`. Don't work around verification.

### Production deployment procedure

1. Work on a branch and open a pull request into `main`.
2. Merge it. Vercel builds `main` and promotes the result to production.
3. If you changed an environment variable, it only takes effect in the next deployment, so redeploy or push.
4. Verify:

   ```bash
   tests/diagnostics/wait_for_deploy.sh <commit-sha>
   tests/diagnostics/smoke_prod.sh
   ```

I'd recommend setting `DATABASE_URL` with the helper rather than at the hidden prompt. It tests the login first and stores exactly the URL that worked:

```bash
~/cgvenv/bin/python tests/diagnostics/set_vercel_db_url.py
```

A mistyped secret can't be read back from Vercel. It only shows up later as `password authentication failed` in the function logs, which is how production ended up with a wrong one the first time.

## Repository administration

### Local indexing and re-indexing

Indexing only happens in the self-hosted stack, through the MCP tools `index_repository(name, path)` and `reindex_repository(name)`. The Python server writes into whatever schema `GRAPH_SCHEMA` names. Check the result with `list_repositories()`.

### Loading a graph into the hosted database

The supported path is the SQLite loader. It copies a SQLite graph (`data/graph.db`, the older on-disk format) into a tenant schema in one transaction and verifies the row counts:

```bash
# 1. See what the file holds and what will not fit
~/cgvenv/bin/python tests/diagnostics/inspect_sqlite_graph.py

# 2. Load it, mapping repos to GitHub for source previews
~/cgvenv/bin/python scripts/load_sqlite_to_supabase.py \
  --exclude <junk-repo> \
  --github <repo>=<github-owner>/<github-repo>@<ref>
```

It prompts for the Supabase `postgres` password (on the session pooler), or takes `--dsn` or `DATABASE_URL`.

`--exclude REPO` leaves a repository out of every table. Use it for anything indexed from a directory that isn't a real repository, and for anything carrying values too large for an index.

It refuses to overwrite an existing graph unless you pass `--replace`, and it refuses an empty source.

If you can, pin `@<ref>` to the commit that was indexed, since snippets are cut by the recorded line numbers.

`scripts/push_to_supabase.sh` copies a local Postgres graph to Supabase, but it targets the older single-tenant `public` tables, not a tenant schema. There's no script yet that copies a local Postgres tenant schema to the hosted database.

### Repository connections and source previews

The hosted explorer and `get_code_snippet` read source from the GitHub repository recorded for each graph repository. To add or change one without reloading:

```sql
INSERT INTO control.repo_connections (tenant_id, repo_name, external_repo, git_ref)
SELECT id, '<repo>', '<github-owner>/<github-repo>', '<commit sha or branch>'
  FROM control.tenants WHERE slug = 'owner'
ON CONFLICT (tenant_id, repo_name)
DO UPDATE SET external_repo = EXCLUDED.external_repo, git_ref = EXCLUDED.git_ref;
```

```sql
SELECT repo_name, external_repo, git_ref FROM control.repo_connections;
```

The app caches tenants for 60 seconds, but connections are read on every request.

### Verifying graph data

`list_repositories()` over MCP shows the counts and `indexed_at`. In SQL, `SELECT name, node_count, edge_count, file_count FROM tenant_owner.repos;` gives you the same.

`scripts/mcp_parity.py` compares the Python and hosted MCP backends call by call. It reports real differences separately from source drift, which is when both agree on the node but read different versions of the file, and that means a `git_ref` needs pinning:

```bash
PARITY_TOKEN_A=<python server token> PARITY_TOKEN_B=<cgk_ token> \
  ~/cgvenv/bin/python scripts/mcp_parity.py http://127.0.0.1:8765/mcp https://<app>/api/mcp
```

## Authentication and access

### Owner authentication

There's one owner and one password (`OWNER_PASSWORD`), and changing it takes a redeploy.

Sessions are signed cookies (`cg_session`) that last seven days. ***Note: changing `SESSION_SECRET` signs everyone out.***

`frontend/lib/viewer.ts` (`getViewer()`) is the one place where a request turns into a viewer: user, role and tenant. The admin guide is only served when that viewer is the owner. When Google and GitHub sign-in arrive, this function changes and the routes behind it don't have to.

### MCP tokens

```bash
~/cgvenv/bin/python scripts/mcp_token.py create --tenant owner --label desktop
~/cgvenv/bin/python scripts/mcp_token.py list
~/cgvenv/bin/python scripts/mcp_token.py revoke <id>
```

A token is printed once. Only its SHA-256 hash is stored, so a lost token can't be recovered, only revoked and replaced.

`list` shows the prefix, label, created and last-used time, never the token itself. Revoking takes effect on the next request.

The scripts use the Supabase session pooler with a password prompt, or `--dsn` or `DATABASE_URL`. Run them as `postgres`, not as the app role.

### Tenant isolation

Each tenant is a schema, `tenant_<slug>`, and `control.tenants`, `control.mcp_tokens` and `control.repo_connections` say who owns what.

A schema name only ever comes from a token or a session, never from a request field. `tbl()` in `frontend/lib/tenancy.ts` checks it against `^tenant_[a-z0-9_]{1,40}$` before it gets anywhere near SQL. `anon` and `authenticated` are revoked on `control` and every tenant schema.

There's one known limit. The app role can read every tenant schema, so isolation is enforced by the application. The hardening option is one role per tenant with `SET ROLE` per request.

### Administrative scripts

| Script | Use |
|---|---|
| `scripts/setup_db.sh` | Create the graph schema: `--docker [NAME] [--create-role]`, `--supabase`, or `--host/--user/--db` |
| `scripts/check_db.py` | Diagnose a `DATABASE_URL`: IPv6-only host, pooler user name, TLS, missing tables |
| `scripts/load_sqlite_to_supabase.py` | Load a SQLite graph into a tenant schema (`--github`, `--exclude`, `--replace`) |
| `scripts/mcp_token.py` | Create, list and revoke MCP tokens |
| `scripts/mcp_parity.py` | Compare the two MCP backends |
| `scripts/push_to_supabase.sh` | Copy a local Postgres graph into Supabase's `public` tables (older layout) |
| `tests/diagnostics/*` | Hand-run checks for Supabase, Vercel and the live deployment; see their README |

## Maintenance

### Health checks

| Check | Expect |
|---|---|
| `GET /api/health` (web app) | `{"status":"ok"}` |
| `GET /healthz` (Python MCP server) | `{"status":"ok"}`, the only unauthenticated route |
| `docker compose ps` | `postgres`, `code-graph-mcp` and `app` all `Up (healthy)` |

### Diagnostics

| Script | When |
|---|---|
| `tests/diagnostics/smoke_prod.sh [url]` | After every deployment. Checks the public pages, the sign-in gate and MCP token rejection (a database round trip), and prints server errors on failure. |
| `tests/diagnostics/wait_for_deploy.sh [sha]` | Right after a push; waits until that commit's deployment is ready or failed. |
| `tests/diagnostics/vercel_status.sh` | Project settings, production branch, environment variable names. |
| `tests/diagnostics/check_db_url.py` | Test a `DATABASE_URL` at a hidden prompt, including the tenant grants. |
| `tests/diagnostics/set_vercel_db_url.py` | Store a tested `DATABASE_URL` in Vercel. |
| `tests/diagnostics/probe_pooler.py` | Does the pooler know this project and user? No password needed. |
| `tests/diagnostics/inspect_sqlite_graph.py` | Before a load: repos, junk, values too large to index. |
| `tests/diagnostics/run_tests.sh` | The Python test suite against the local Postgres container. |

### Common operational failures

| Symptom | Cause | Fix |
|---|---|---|
| Function logs: `password authentication failed for user "codegraph_app"` | `DATABASE_URL` in Vercel doesn't match the role's password | Test with `check_db_url.py`, store with `set_vercel_db_url.py`, redeploy |
| `Tenant or user not found` | Pooler user without `.<project-ref>`, or another region's pooler host | Fix the user name or host; `probe_pooler.py` confirms |
| `self-signed certificate in certificate chain` | `DATABASE_CA_CERT` missing or wrong | Set the Supabase CA PEM |
| `permission denied for schema` or table | The app role is missing grants on a tenant schema | Re-run the grants above |
| Sign-in page says sign-in is not set up | `OWNER_PASSWORD` or `SESSION_SECRET` missing or too short on that deployment | Set them for that environment and redeploy; the function log names the one missing |
| Loader: `index row size … exceeds btree version 4 maximum` | A repository holds values too large to index, typically inline `data:` URIs from a directory that isn't a real repository | `inspect_sqlite_graph.py`, then `--exclude` it |
| `/api/mcp` answers 401 | Missing, wrong or revoked token | `mcp_token.py list`; check the client's environment; restart the client |
| `/api/mcp` answers 403 "not served by the MCP upstream" | Proxy mode with a non-owner tenant | Expected until the Python server is tenant-aware |
| `/api/mcp` returns a Vercel login page | Deployment Protection on a preview URL | Use the production URL |
| Snippets show the wrong lines | The graph was built from a different commit than `git_ref` | Pin `git_ref`, or reload a fresher graph |
| "GitHub rate limit" | No `GITHUB_TOKEN` | Set one |

### Backup and recovery

The graph itself is derived data, so it can always be rebuilt: re-index in the self-hosted stack, then reload with `--replace`. There's no separate backup tooling for the graph.

The control plane is a different story, because it isn't derived. Tokens and repository connections only live in `control`, and losing it means re-minting every token and re-adding every connection. Nothing backs it up for you yet. A manual dump with standard Postgres tools covers it, for example `pg_dump --schema=control` over the session pooler as `postgres`.

Supabase's own backups depend on the project's plan, so check the dashboard before you rely on them.

Locally, the graph lives in the `pgdata` volume (or in the external container's volume). ***Note: `docker compose down -v` deletes it.***

### Deployment verification

After a production deployment, run `wait_for_deploy.sh`, then `smoke_prod.sh`, then sign in and open a repository and a node to make sure previews work. If anything looks off, `vercel_status.sh` shows what the project is set to.

## Future administration

None of this exists yet. It's the plan, and the design is in `docs/FUTURE_STATE.md` in the repository.

Sign-in with Google and GitHub will go through Supabase Auth. Once the owner links their own account, the password login gets switched off.

New sign-ins will wait in a `pending` state until the owner approves them, and approving one provisions a tenant and its schema. Suspending a user will stop their MCP access within the 60-second tenant cache.

There'll be an admin portal at `/admin`:

| Page | Contents |
|---|---|
| Users | Pending, active and suspended users; approve, suspend, delete |
| Tenants | Size, repositories, last index; re-index or delete |
| Tokens | Every token; revoke |
| Jobs | Index jobs with status and error; retry or cancel |
| Audit | Every administrative action |

Users will pick the repositories ContextForge can read by installing a GitHub App, so GitHub itself enforces the choice.

Indexing will move to the cloud: an index job queue, with the existing Python indexer as a worker on a container host, recording the indexed commit so previews stay exact. Re-indexing on push via webhook comes after that.

Before sign-ups open, the plan is to harden things with per-tenant database roles, token expiry, per-token rate limits and per-user quotas.
