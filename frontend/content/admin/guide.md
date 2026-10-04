## Deployment and infrastructure

### Components

| Component | Self-hosted | Hosted |
|---|---|---|
| Web app (explorer, docs, `/api/mcp`) | `app` service, `127.0.0.1:3000` | Vercel project, Root Directory `frontend`, Next.js |
| MCP server with indexing | `code-graph-mcp` service, `127.0.0.1:8765` | none: the hosted app answers MCP itself (`MCP_BACKEND=native`) |
| Graph database | `postgres` service, or an existing Postgres container | Supabase Postgres |
| Source text for previews | the MCP container reads `/workspaces` | GitHub, through `control.repo_connections` |

Vercel functions are pinned to one region in `frontend/vercel.json`. Keep it next to the database's region: every graph query crosses that link.

### Local Docker deployment

The public [getting started guide](/docs/getting-started) is the full procedure. Operational notes:

- **Use an existing Postgres container** instead of the stack's own by adding the external-database overlay in `.env`:

  ```bash
  COMPOSE_FILE=docker-compose.yml:docker-compose.external-db.yml
  POSTGRES_HOST=<container-name>
  EXTERNAL_DB_NETWORK=<that container's docker network>
  ```

  Create the role and database there first:

  ```bash
  ./scripts/setup_db.sh --docker <container-name> --create-role
  ```

  A container on another project's network publishes no host port, so host-side tools (pytest, the admin scripts) reach it by the container's IP on that network. `tests/diagnostics/run_tests.sh` works that out for you.

- **Compose checks every service's required variables before any command**, so `.env` needs `POSTGRES_PASSWORD`, `CODE_GRAPH_TOKEN`, `OWNER_PASSWORD` and `SESSION_SECRET` even to run a one-off command against a single service.
- **After pulling new code**, rebuild the images: `docker compose build`, then `docker compose up -d`. A stale `code-graph-mcp` image is missing newer modules, such as `control`.

### Hosted architecture

```text
  Claude Code ──Bearer cgk_…──► /api/mcp ─┐
                                          ├── Next.js (Vercel) ──► Supabase Postgres (transaction pooler, TLS, CA-verified)
  Browser ──owner sign-in─────► /graph  ──┘                   └──► GitHub API (source text per request)
```

- **Vercel:** production deploys the `main` branch; every other branch gets a preview deployment. Previews have no database secrets unless you add them to the Preview environment.
- **Supabase:** two pooler ports, both on IPv4. The direct `db.<project-ref>.supabase.co` host is IPv6-only, so avoid it.
  - **Session pooler, port 5432:** for admin scripts. It supports long transactions.
  - **Transaction pooler, port 6543:** for the Vercel app. It opens a connection per statement, which suits serverless instances.
- **Pooler user names carry the project ref:** `postgres.<project-ref>` for administration, `codegraph_app.<project-ref>` for the app. Without the suffix the pooler answers `Tenant or user not found`.

### Environment variables

**Web app** (Vercel, or the `app` service):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql://codegraph_app.<project-ref>:<password>@<pooler-host>:6543/postgres` when hosted. URL-encode special characters in the password. |
| `DATABASE_CA_CERT` | hosted | The full PEM of Supabase's CA. A literal `\n` is accepted in place of newlines. |
| `PGPOOL_MAX` | hosted | `1` on Vercel: one connection per function instance. |
| `OWNER_PASSWORD` | yes, unless GitHub sign-in is set up | The owner's break-glass sign-in password, 12 or more characters. |
| `SESSION_SECRET` | yes | Signs session cookies, 32 or more characters (`openssl rand -hex 32`). |
| `OWNER_TENANT_SLUG` | no | The tenant the owner signs in to. Default `owner`. |
| `SOURCE_PROVIDER` | no | `github` (default), `mcp` or `none`. |
| `GITHUB_TOKEN` | hosted | A read-only, fine-grained token for repositories connected without a token of their own (the loader's). |
| `GITHUB_TOKEN_KEY` | for `/settings` | 64 hex characters (`openssl rand -hex 32`). Encrypts stored GitHub tokens; the indexer needs the same value. |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | for GitHub sign-in | The GitHub OAuth app. Unset: owner password only. |
| `OWNER_GITHUB_LOGIN` | for GitHub sign-in | Your GitHub login: it opens the owner tenant as a platform admin, with no approval. |
| `PUBLIC_APP_URL` | for GitHub sign-in | The site's origin, used for the OAuth callback URL. |
| `INDEXER_URL` / `INDEXER_SECRET` | for cloud indexing | The indexer's Function URL and the secret shared with it (`docs/INDEXER_AWS.md`). |
| `MCP_BACKEND` | no | `native` (default) or `proxy`. |
| `MCP_UPSTREAM_URL` / `MCP_UPSTREAM_TOKEN` | proxy only | Where `/api/mcp` forwards, and the token it sends. |
| `MCP_BASE_URL` / `CODE_GRAPH_TOKEN` | `SOURCE_PROVIDER=mcp` | The Python MCP server's base URL and token, for reading source. |
| `SITE_URL` | no | The canonical site origin for metadata and the sitemap. Default `https://contextforge.ai`. |

**Self-hosted stack** (`.env`):

| Variable | Purpose |
|---|---|
| `REPOS_HOST_PATH` | Parent directory of indexable repositories, mounted read-only at `/workspaces` |
| `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB` | The local graph database (user and database default to `codegraph`) |
| `CODE_GRAPH_TOKEN` | The MCP server's shared secret. Required. |
| `GRAPH_SCHEMA` | The schema the Python server reads and writes: `tenant_owner` for the explorer's layout |
| `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` | Only for the opt-in tunnel profile |
| `COMPOSE_FILE`, `POSTGRES_HOST`, `EXTERNAL_DB_NETWORK` | The external-database overlay (above) |
| `MAX_FILE_BYTES`, `COMMIT_BATCH_FILES` | Indexer limits: 1.5 MB and 200 files by default |

Claude Code reads `CODE_GRAPH_MCP_URL` and `CODE_GRAPH_TOKEN` from **its own** environment (`setx` on Windows), not from `.env`.

### Database configuration

1. **Create the schema.** The loader creates `control` and the tenant schema itself (below). For the older single-tenant `public` layout, `./scripts/setup_db.sh --supabase`.
2. **Create the app's restricted role** in the Supabase SQL Editor, `CREATE ROLE codegraph_app LOGIN PASSWORD '<a long random password>';`, then apply its grants (as `postgres`; idempotent, re-run after control-plane changes):

   ```bash
   ~/cgvenv/bin/python scripts/migrate_control.py --app-role codegraph_app
   ```

   The role reads `control` and every tenant graph, writes only `users`, `members`, `github_tokens`, `repo_connections` and `index_jobs`, and creates a tenant only through `control.provision_tenant` (SECURITY DEFINER), which approving a sign-up calls. It cannot run DDL or write a graph. `--replace` loads keep the grants, because they truncate tables rather than drop them. To change the password later, run `ALTER ROLE codegraph_app WITH PASSWORD '<new password>';` and update `DATABASE_URL`.
3. **Trust the CA.** Download the certificate from Supabase (Project Settings → Database → SSL Configuration) into `DATABASE_CA_CERT`. Never work around verification.

### Production deployment procedure

1. Work on a branch; open a pull request into `main`.
2. Merge it. Vercel builds `main` and promotes the result to production.
3. Changed an environment variable? It only takes effect in the **next** deployment. Redeploy, or push.
4. Verify:

   ```bash
   tests/diagnostics/wait_for_deploy.sh <commit-sha>
   tests/diagnostics/smoke_prod.sh
   ```

**Set `DATABASE_URL` with the helper, not the hidden prompt.** It tests the login first and stores exactly the URL that worked:

```bash
~/cgvenv/bin/python tests/diagnostics/set_vercel_db_url.py
```

A mistyped secret cannot be read back from Vercel; it only shows up as `password authentication failed` in the function logs.

## Repository administration

### Local indexing and re-indexing

Indexing happens only in the self-hosted stack, through the MCP tools: `index_repository(name, path)` and `reindex_repository(name)`. The Python server writes into the schema named by `GRAPH_SCHEMA`. Check the result with `list_repositories()`.

### Loading a graph into the hosted database

The supported path is the **SQLite loader**, which copies a SQLite graph (`data/graph.db`, the older on-disk format) into a tenant schema in one transaction and verifies row counts:

```bash
# 1. See what the file holds and what will not fit
~/cgvenv/bin/python tests/diagnostics/inspect_sqlite_graph.py

# 2. Load it, mapping repos to GitHub for source previews
~/cgvenv/bin/python scripts/load_sqlite_to_supabase.py \
  --exclude <junk-repo> \
  --github <repo>=<github-owner>/<github-repo>@<ref>
```

- It prompts for the Supabase `postgres` password (session pooler), or takes `--dsn` or `DATABASE_URL`.
- `--exclude REPO` leaves a repository out of every table. Use it for anything indexed from a directory that is not a real repository, and for anything carrying values too large for an index.
- It refuses to overwrite an existing graph without `--replace`, and it refuses an empty source.
- Pin `@<ref>` to the commit that was indexed, if you can. Snippets are cut by recorded line numbers.

`scripts/push_to_supabase.sh` copies a **local Postgres** graph to Supabase, but it targets the older single-tenant `public` tables, not a tenant schema. There is no script yet that copies a local Postgres tenant schema to the hosted database.

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

Tenants are cached by the app for 60 seconds; connections are read on each request.

### Verifying graph data

- `list_repositories()` over MCP shows counts and `indexed_at`.
- In SQL: `SELECT name, node_count, edge_count, file_count FROM tenant_owner.repos;`
- `scripts/mcp_parity.py` compares the Python and hosted MCP backends call by call, reporting real differences and **source drift** (both agree on the node, but read different file versions, which means a `git_ref` needs pinning):

  ```bash
  PARITY_TOKEN_A=<python server token> PARITY_TOKEN_B=<cgk_ token> \
    ~/cgvenv/bin/python scripts/mcp_parity.py http://127.0.0.1:8765/mcp https://<app>/api/mcp
  ```

## Authentication and access

### Sign-in

- **Continue with GitHub** (a GitHub OAuth app; callback `https://<app>/api/auth/github/callback`). GitHub is asked only for `read:user user:email`; the OAuth token is used once to read the profile and discarded.
- A first sign-in creates a **pending** account. Approve it on `/settings` → **People**: approval provisions the person's own graph, `tenant_gh_<github id>`. **Suspend** ends their web access on their next request (the session is re-checked against `control.users` every time). MCP tokens belong to the tenant, not the person: revoke theirs with `scripts/mcp_token.py` too.
- `OWNER_GITHUB_LOGIN` signs straight into the owner tenant as a platform admin. Platform admin (`control.users.is_platform_admin`) is separate from owning a tenant: every approved person owns their own graph, only admins see People and this guide.
- The owner password (`OWNER_PASSWORD`) remains as a break-glass sign-in; unset it to switch it off.
- Sessions are signed cookies (`cg_session`) valid for seven days. **Changing `SESSION_SECRET` signs everyone out.**
- `frontend/lib/viewer.ts` (`getViewer()`) is the single point where a request becomes a viewer: user, role and tenant.

### GitHub tokens and repositories

- People add **fine-grained** tokens (`github_pat_…`) on `/settings`: the page opens GitHub's token form pre-filled with read-only Contents and Metadata (plus Webhooks, optionally); they pick the repositories on GitHub and paste the token back. The app checks it with GitHub and refuses classic tokens and tokens belonging to someone else.
- Tokens are stored AES-256-GCM-encrypted under `GITHUB_TOKEN_KEY`, bound to their tenant, and used only server-side: for source previews of that tenant's connections, listing the repositories a token can see, registering push webhooks, and by the indexer.
- A tenant keeps any number of tokens; each repo connection names the one that reads it.

### MCP tokens

```bash
~/cgvenv/bin/python scripts/mcp_token.py create --tenant owner --label desktop
~/cgvenv/bin/python scripts/mcp_token.py list
~/cgvenv/bin/python scripts/mcp_token.py revoke <id>
```

- A token is printed **once**. Only its SHA-256 hash is stored; a lost token cannot be recovered, only revoked and replaced.
- `list` shows prefix, label, created and last-used time, never the token.
- Revocation takes effect on the next request.
- The scripts use the Supabase session pooler with a password prompt, or `--dsn` or `DATABASE_URL`. Run them as `postgres`, not the app role.

### Tenant isolation

- Each tenant is a schema, `tenant_<slug>`. `control.tenants`, `control.mcp_tokens` and `control.repo_connections` say who owns what.
- A schema name only ever comes from a token or a session, never a request field. `tbl()` in `frontend/lib/tenancy.ts` validates it against `^tenant_[a-z0-9_]{1,40}$` before it reaches SQL.
- `anon` and `authenticated` are revoked on `control` and every tenant schema.
- **Known limit:** the app role can read every tenant schema, so isolation is enforced by the application. The hardening option is one role per tenant with `SET ROLE` per request.

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
| `tests/diagnostics/smoke_prod.sh [url]` | After every deployment. Checks public pages, the sign-in gate and MCP token rejection (a database round trip), and prints server errors on failure. |
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
| Function logs: `password authentication failed for user "codegraph_app"` | `DATABASE_URL` in Vercel does not match the role's password | Test with `check_db_url.py`, store with `set_vercel_db_url.py`, redeploy |
| `Tenant or user not found` | Pooler user without `.<project-ref>`, or another region's pooler host | Fix the user name or host; `probe_pooler.py` confirms |
| `self-signed certificate in certificate chain` | `DATABASE_CA_CERT` missing or wrong | Set the Supabase CA PEM |
| `permission denied for schema` or table | The app role lacks grants on a tenant schema | Re-run the grants above |
| Loader: `index row size … exceeds btree version 4 maximum` | A repository holds values too large to index, typically inline `data:` URIs from a directory that is not a real repository | `inspect_sqlite_graph.py`, then `--exclude` it |
| `/api/mcp` answers 401 | Missing, wrong or revoked token | `mcp_token.py list`; check the client's environment; restart the client |
| `/api/mcp` answers 403 "not served by the MCP upstream" | Proxy mode with a non-owner tenant | Expected until the Python server is tenant-aware |
| `/api/mcp` returns a Vercel login page | Deployment Protection on a preview URL | Use the production URL |
| Server errors, logs say "must be at least" | `OWNER_PASSWORD` under 12 or `SESSION_SECRET` under 32 characters | Lengthen and redeploy |
| Snippets show the wrong lines | The graph was built from a different commit than `git_ref` | Pin `git_ref`, or reload a fresher graph |
| "GitHub rate limit" | No `GITHUB_TOKEN` | Set one |

### Backup and recovery

- **The graph is derived data.** It can always be rebuilt: re-index in the self-hosted stack, then reload with `--replace`. There is no separate graph backup tooling.
- **The control plane is not derived.** Tokens and repository connections live only in `control`. Losing it means re-minting every token and re-adding connections. No backup of it is scripted; a manual dump with standard Postgres tools, for example `pg_dump --schema=control`, over the session pooler as `postgres`, captures it.
- **Supabase's own backups** depend on the project's plan. Check the dashboard before relying on them.
- **Locally**, the graph lives in the `pgdata` volume, or in the external container's volume. `docker compose down -v` **deletes** it.

### Deployment verification

After a production deployment: `wait_for_deploy.sh`, then `smoke_prod.sh`, then sign in and open a repository and a node to confirm previews work. `vercel_status.sh` shows what the project is set to if anything looks wrong.

## Cloud indexing

Connected repositories are indexed on AWS Lambda from GitHub: daily, on every push (webhook or the `index-on-push.yml` GitHub Actions workflow) and on demand (**Index now**). Each run is a row in `control.index_jobs`, shown on `/settings`. Setup, costs (inside the AWS free tier) and operations are in `docs/INDEXER_AWS.md`; the deploy is `.github/workflows/deploy-indexer.yml`.

## Future administration

**Planned. None of this exists yet.** The design is in `docs/FUTURE_STATE.md` in the repository.

- **Sign-in with Google.**
- **Self-service MCP tokens.** Today the administrator mints them with `scripts/mcp_token.py`, including for approved users' tenants (`--tenant gh_<github id>`).
- **An admin portal** at `/admin`:

  | Page | Contents |
  |---|---|
  | Users | Pending, active and suspended users; approve, suspend, delete |
  | Tenants | Size, repositories, last index; re-index or delete |
  | Tokens | Every token; revoke |
  | Jobs | Index jobs with status and error; retry or cancel |
  | Audit | Every administrative action |

- **Hardening before opening sign-ups:** per-tenant database roles, token expiry, per-token rate limits and per-user quotas.
