# Admin guide — running the code graph in the cloud

How the cloud version was built, how to bring it up, and how to operate it.
It is written for the owner (the only admin today). What exists is described
in [CURRENT_STATE.md](CURRENT_STATE.md) (the baseline) and
[FUTURE_STATE.md](FUTURE_STATE.md) (the target, with what is built and what is
only designed).

This is a living document. When a phase from FUTURE_STATE.md is built, add its
steps here and a line to the [build log](#build-log).

---

## Contents

1. [What you are deploying](#1-what-you-are-deploying)
2. [One-time setup](#2-one-time-setup): Supabase, loading the graph, the app role, Vercel, Claude Code, sign-in with GitHub, the cloud indexer
3. [Day-to-day operations](#3-day-to-day-operations)
4. [Switches](#4-switches)
5. [Running it locally](#5-running-it-locally)
6. [Troubleshooting](#6-troubleshooting)
7. [How it was built](#7-how-it-was-built)
8. [Build log](#build-log)

---

## 1. What you are deploying

| Piece | Where | What it does |
|---|---|---|
| Graph database | Supabase `rryfmnktebyvfxaftvyv` (Singapore, `ap-southeast-1`) | `control` schema (tenants, users, MCP tokens, GitHub tokens, repo connections, index jobs) and one `tenant_<slug>` graph per tenant |
| App | Vercel, root directory `frontend/`, region `sin1` | the graph page at `/graph`, `/settings`, and the MCP endpoint at `/api/mcp` |
| Indexer | AWS Lambda, `ap-southeast-1` ([INDEXER_AWS.md](INDEXER_AWS.md)) | re-indexes connected GitHub repositories daily, on push and on demand |
| Source text | GitHub | read per request for README, file and snippet previews; never stored |
| Claude Code | your machine | connects to `https://<app>/api/mcp` with a token |

Nothing in this setup needs your desktop to be on. With the indexer deployed
(§2.8), graphs are built in the cloud from GitHub; without it, the graph is
the one you loaded from SQLite.

---

## 2. One-time setup

All commands run in WSL, in the project directory, with the dev venv:

```bash
cd '/mnt/f/The Data Platform Project/Code Graph/code-graph-mcp'
git pull                       # branch main
PY=~/cgvenv/bin/python
```

### 2.1 Load your graph into Supabase

The graph from the SQLite version is in `data/graph.db`. The loader copies it
into `tenant_owner`, creating the `control` schema on the way. It connects
through the **session pooler** (IPv4, port 5432) and prompts for your
Supabase database password.

First look at what is in the file. The loader prints this before asking to
proceed, so you can answer `n` the first time:

```bash
$PY scripts/load_sqlite_to_supabase.py
```

Then load it for real, telling it which GitHub repository each graph repo
comes from. Source previews need that mapping. Use the repo names the first
run printed:

```bash
$PY scripts/load_sqlite_to_supabase.py \
  --github data-platform=The-Data-Platform-Project/data-platform@main \
  --github code-graph-mcp=The-Data-Platform-Project/code-graph-mcp@main
```

- `@ref` is optional (the default branch is used without it). **Pin it to the
  commit the graph was indexed from** if you can. Snippets are cut by the line
  numbers in the graph, so if the file has changed since, you get the wrong
  lines. To find that commit, take `indexed_at` from the first run and ask git:
  `git -C <repo> rev-list -1 --before="<indexed_at>" HEAD`. (If the working copy
  had uncommitted changes when it was indexed, no commit matches exactly;
  re-indexing is the real fix, see FUTURE_STATE.md §4.)
- It runs in **one transaction** and verifies row counts before committing.
  If anything fails, nothing is written.
- It refuses to overwrite an existing graph. Pass `--replace` to reload.
- `--exclude REPO` (repeatable) leaves a repo out of every table. The desktop's
  SQLite graph holds `telemetry-pipeline`, which was indexed from the root of
  F: (path `.`: VS Code, Packet Tracer, `$RECYCLE.BIN`, ...) and carries inline
  `data:` URIs too large for a Postgres index. Exclude it.
- The old empty graph tables in Supabase's `public` schema are unused. You can
  leave them or drop them.

### 2.2 Create a restricted role for the app

The app reads graphs and writes only the control-plane rows people change on
`/settings`: their account, GitHub tokens, repo connections and index jobs. Give
it a role that can do exactly that, rather than the `postgres` password. In the
Supabase dashboard, open **SQL Editor** and run:

```sql
CREATE ROLE codegraph_app LOGIN PASSWORD '<a long random password>';
```

Then create or upgrade the control schema and apply the role's grants (as
`postgres`; re-run after any change to `src/code_graph/control.py`, it is
idempotent):

```bash
$PY scripts/migrate_control.py --app-role codegraph_app
```

What it grants: read on `control`; insert, update and delete on `users`,
`members`, `github_tokens`, `repo_connections` and `index_jobs`; `last_used_at`
on `mcp_tokens`; read on every existing tenant schema; and execute on
`control.provision_tenant`. That function (SECURITY DEFINER) is the only way
the app can create a schema: approving a sign-up calls it, and it grants the
app read access to the new graph. The app cannot run DDL or write any graph.
`tests/test_control_plane.py` runs under exactly this grant set.

Through the pooler, its username is `codegraph_app.rryfmnktebyvfxaftvyv`.
`--replace` loads keep the grants, because they truncate tables rather than
dropping them.

### 2.3 Get Supabase's CA certificate

Supabase signs its database certificates with its own CA, which Node does not
trust by default, so the app cannot verify the connection without it.
Dashboard → **Project Settings → Database → SSL Configuration → Download
certificate**. You will paste its contents into Vercel next. Do not work
around this by turning verification off.

### 2.4 Mint secrets

```bash
openssl rand -hex 32     # SESSION_SECRET
```

Choose an `OWNER_PASSWORD` of at least 12 characters. That is what you type on
the login page.

For source previews of repos connected without a token of their own (such as
the ones the loader created), create a **fine-grained GitHub token** with
read-only *Contents* access to just those repos. That is `GITHUB_TOKEN`. Even
for public repos, set one: unauthenticated GitHub allows 60 requests an hour.
Repos connected on `/settings` use the token chosen there instead.

For sign-in with GitHub and the cloud indexer (§2.7, §2.8):

```bash
openssl rand -hex 32     # GITHUB_TOKEN_KEY: encrypts stored GitHub tokens
openssl rand -hex 32     # INDEXER_SECRET: signs index requests, derives webhook secrets
```

Both also go into the indexer's SSM parameters and must match there.

### 2.5 Configure Vercel

The existing Vercel project `code-graph-viz` points at `visualizer/`, which
is wrong. In **Settings → Build and Deployment**, set **Root Directory =
`frontend`** (Framework: Next.js). `frontend/vercel.json` pins functions to
`sin1`, next to the database.

**Settings → Environment Variables** (Production, and Preview if you use it):

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://codegraph_app.rryfmnktebyvfxaftvyv:<password>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres` (**transaction** pooler, 6543; URL-encode special characters in the password) |
| `DATABASE_CA_CERT` | the full PEM from 2.3, including the BEGIN/END lines |
| `PGPOOL_MAX` | `1` |
| `OWNER_PASSWORD` | from 2.4 |
| `SESSION_SECRET` | from 2.4 |
| `SOURCE_PROVIDER` | `github` |
| `GITHUB_TOKEN` | from 2.4 |
| `MCP_BACKEND` | `native` |
| `GITHUB_TOKEN_KEY` | from 2.4 (needed for `/settings`) |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | from 2.7 |
| `OWNER_GITHUB_LOGIN` | your GitHub login (2.7) |
| `PUBLIC_APP_URL` | `https://<app>`, the origin GitHub redirects back to |
| `INDEXER_URL` / `INDEXER_SECRET` | from 2.8 |

Store `DATABASE_URL` with `tests/diagnostics/set_vercel_db_url.py` rather
than at `vercel env add`'s hidden prompt. It tests the login first and stores
exactly the URL that worked, percent-encoded. A mistyped value can't be read
back, and only shows up as `password authentication failed` in the function
logs.

**Which branch deploys.** Production tracks `main` (**Settings → Environments
→ Production → Branch Tracking**); every other branch gets a preview
deployment. A preview deployment works for the public pages. But if **Deployment
Protection** is on for previews, Vercel answers Claude Code's MCP calls with
its own login wall, so use production for MCP.

Deploy, then check:

```bash
curl https://<app>/api/health          # {"status":"ok"}
```

Open `https://<app>/graph`, sign in with `OWNER_PASSWORD`, and click a repo (README)
and a node (source preview).

### 2.6 Connect Claude Code

Mint a token for your tenant. It is printed **once**; only its hash is stored:

```bash
$PY scripts/mcp_token.py create --tenant owner --label desktop
```

`.mcp.json` reads both the URL and the token from your Windows environment,
so switching Claude Code between the local container and the cloud is an
environment change, not a file edit:

```powershell
setx CODE_GRAPH_MCP_URL "https://<app>/api/mcp"
setx CODE_GRAPH_TOKEN   "cgk_…"          # the token just printed
```

Restart Claude Code and run `/mcp`. You should see `code-graph` with seven
tools. The cloud has no `index_repository` and no `reindex_repository`. To go
back to the local container, set `CODE_GRAPH_MCP_URL` to
`http://127.0.0.1:8765/mcp` and `CODE_GRAPH_TOKEN` back to the value in `.env`.

To use it outside this project, add the same block from `.mcp.json` to your
user-level Claude Code config.

### 2.7 Sign-in with GitHub

People sign up with their GitHub account; you approve them; each approved
person gets their own graph (`tenant_gh_<github id>`).

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
   Homepage `https://<app>`, callback URL
   `https://<app>/api/auth/github/callback`. Generate a client secret.
2. On Vercel set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `PUBLIC_APP_URL=https://<app>` and `OWNER_GITHUB_LOGIN=<your login>`, then
   redeploy. The login page now offers **Continue with GitHub**.
3. Sign in with GitHub yourself. Your login lands in the existing `owner`
   tenant as a platform admin, with no approval step.
4. Once that works, unset `OWNER_PASSWORD` if you want GitHub to be the only
   way in. Keep it if you want a break-glass sign-in.

The consent screen asks only for `read:user user:email`: who the person is.
The OAuth token is used once to read that and then discarded. Repository
access comes from the fine-grained tokens people add on `/settings`, each
limited by GitHub to the repositories they pick. Those tokens are stored
AES-256-GCM-encrypted under `GITHUB_TOKEN_KEY`, bound to their tenant, and must
belong to the GitHub account that adds them.

**Approving people:** `/settings` → **People** lists every sign-in, pending
first. **Approve** provisions their graph; **Suspend** cuts off their next
web request (the session is re-checked on every request). MCP tokens belong to
the tenant, so also revoke theirs: `$PY scripts/mcp_token.py list --tenant gh_<id>`, then `revoke`.

### 2.8 The cloud indexer

Indexes connected repositories from GitHub on AWS (free tier), deployed by
GitHub Actions. Setup, costs and operations: [INDEXER_AWS.md](INDEXER_AWS.md).

---

## 3. Day-to-day operations

All the scripts take `--dsn` or `$DATABASE_URL`, or default to the Supabase
session pooler with a password prompt. Use the `postgres` user here, not the
read-only app role.

| Task | How |
|---|---|
| List tokens | `$PY scripts/mcp_token.py list` (prefix, label, created, last used; never the token) |
| Revoke a token | `$PY scripts/mcp_token.py revoke <id>`, effective on the next call |
| Replace a lost token | revoke it, create a new one. Tokens cannot be recovered. |
| Reload the graph | re-run the loader with `--replace` (and the same `--github` flags) |
| Change a repo's GitHub mapping or ref | SQL below |
| Log everyone out | change `SESSION_SECRET` and redeploy |
| Change the login password | change `OWNER_PASSWORD` and redeploy |
| Check both MCP backends agree | [§4 parity check](#parity-check) |
| Approve or suspend a person | `/settings` → People |
| See index runs and failures | `/settings` → Recent index runs (per tenant), or `control.index_jobs` |
| Upgrade the control schema | `$PY scripts/migrate_control.py --app-role codegraph_app` (or the deploy workflow's `MIGRATE_DATABASE_URL`) |

Changing a repo mapping without a reload:

```sql
INSERT INTO control.repo_connections (tenant_id, repo_name, external_repo, git_ref)
SELECT id, 'data-platform', 'The-Data-Platform-Project/data-platform', '<commit sha>'
  FROM control.tenants WHERE slug = 'owner'
ON CONFLICT (tenant_id, repo_name)
DO UPDATE SET external_repo = EXCLUDED.external_repo, git_ref = EXCLUDED.git_ref;
```

The app caches tenants for 60 seconds. Connection changes are read per
request.

---

## 4. Switches

Everything that can be switched is an environment variable on the app.

| Variable | Values | Effect |
|---|---|---|
| `MCP_BACKEND` | `native` (default) | MCP tools answered inside the app, from Postgres |
| | `proxy` | `/api/mcp` forwards to `MCP_UPSTREAM_URL` (the Python server on a container) with `MCP_UPSTREAM_TOKEN`. Clients keep the same URL and token. Only the owner tenant is forwarded until the Python server is tenant-aware. |
| `SOURCE_PROVIDER` | `github` (cloud default) | previews read GitHub via `control.repo_connections` |
| | `mcp` | previews read the Python container's `/api/file` and `/api/readme` (`MCP_BASE_URL`, `CODE_GRAPH_TOKEN`); for local/tunnel setups |
| | `none` | previews off; the graph still works |
| `OWNER_TENANT_SLUG` | default `owner` | which tenant the owner password and `OWNER_GITHUB_LOGIN` open |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | unset | no "Continue with GitHub"; owner password only |
| `INDEXER_URL` | unset | no cloud indexer: connections are recorded but not indexed |
| `PGPOOL_MAX` | `1` on Vercel | connections per function instance |

### Parity check

Before switching `MCP_BACKEND` either way, confirm both backends answer the
same. Run the Python server against the same database (`GRAPH_SCHEMA=tenant_owner`),
then:

```bash
PARITY_TOKEN_A=<python server token> PARITY_TOKEN_B=<cgk_ token> \
  $PY scripts/mcp_parity.py http://127.0.0.1:8765/mcp https://<app>/api/mcp
```

It calls every tool on a sample of symbols and files and prints each
difference. **Source drift** is reported separately: both sides agree on the
node, but read different versions of the file. That means a `git_ref` needs
pinning, not a code bug. Last run (on this branch's graph): 254 calls, 0
differences.

---

## 5. Running it locally

The compose stack still works and now uses the same tenant layout:

- `.env` needs `OWNER_PASSWORD` and `SESSION_SECRET` as well as
  `POSTGRES_PASSWORD` and `CODE_GRAPH_TOKEN`; compose refuses to start
  without them.
- To browse the loaded owner graph locally, load it into the local Postgres
  too (`--dsn postgresql://codegraph:…@<container ip>:5432/codegraph`) and set
  `GRAPH_SCHEMA=tenant_owner`. The Python server then reads and indexes that
  schema.
- The local app defaults to `SOURCE_PROVIDER=mcp` (previews from your disk).
- MCP tokens for the app's `/api/mcp` come from `mcp_token.py`, as in the
  cloud. The Python server's own `/mcp` still uses `CODE_GRAPH_TOKEN`.

---

## 6. Troubleshooting

Start with `tests/diagnostics/smoke_prod.sh`: it checks the live app and, if
anything fails, prints the server's own errors. The other scripts in
[tests/diagnostics](../tests/diagnostics/README.md) check each piece on its own:
the pooler, a `DATABASE_URL`, the Vercel settings and the SQLite graph before
a load.

| Symptom | Cause | Fix |
|---|---|---|
| App logs `self-signed certificate in certificate chain` or `unable to verify the first certificate` | Supabase CA not configured | set `DATABASE_CA_CERT` (§2.3) |
| `Tenant or user not found` | pooler username without the project suffix | `codegraph_app.rryfmnktebyvfxaftvyv` |
| Loader cannot connect at all | direct host `db.<ref>.supabase.co` is IPv6-only | use the session pooler (the default) |
| `/api/mcp` → 401 | missing, wrong or revoked token | `mcp_token.py list`; check `CODE_GRAPH_TOKEN` in the *Windows* environment; restart Claude Code |
| `/api/mcp` → 403 "not served by the MCP upstream" | proxy mode with a non-owner tenant | expected until FUTURE_STATE.md §5 |
| `/api/mcp` → Vercel login page | Deployment Protection on a preview | use the production deployment |
| Snippets show the wrong lines | graph built from a different commit than `git_ref` | pin `git_ref` (§3), or reload a fresher graph |
| README or file "not found on GitHub" | private repo and `GITHUB_TOKEN` cannot see it, or no mapping | check the token's repo access; add the mapping (§3) |
| "GitHub rate limit" | no `GITHUB_TOKEN` | set it |
| Every page redirects to `/login` | no or expired session (7 days), or `SESSION_SECRET` changed | sign in again |
| Sign-in or pages fail with 500; function logs say "must be at least" | `OWNER_PASSWORD` < 12 or `SESSION_SECRET` < 32 characters | lengthen them and redeploy |

---

## 7. How it was built

The design, and why each decision was made, is in FUTURE_STATE.md. This is
the map from the design to the code.

| Concern | Code |
|---|---|
| Control plane DDL, tenant creation, tokens | `src/code_graph/control.py` |
| SQLite → tenant schema loader | `src/code_graph/sqlite_import.py`, `scripts/load_sqlite_to_supabase.py` |
| Admin script connection options | `src/code_graph/pgcli.py` |
| Token CLI | `scripts/mcp_token.py` |
| Parity check | `scripts/mcp_parity.py` |
| Schema validation and qualification | `frontend/lib/tenancy.ts` (`tbl()`) |
| Graph queries (TS port of `queries.py`) | `frontend/lib/graph.ts` |
| Token → tenant, repo connections | `frontend/lib/control.ts` |
| Who is viewing: **the auth seam** | `frontend/lib/viewer.ts` (`getViewer()`) |
| Signed session cookie | `frontend/lib/session.ts`; issued by `app/api/auth/login` |
| Page gate | `frontend/middleware.ts` |
| Source providers | `frontend/lib/source.ts` |
| MCP tools | `frontend/lib/mcpServer.ts` |
| MCP endpoint, native and proxy | `frontend/app/api/mcp/route.ts` |
| Database pool and TLS | `frontend/lib/pool.ts` |

**Invariants to keep when changing it:**

- A schema name only ever comes from the control plane (token or session),
  and goes through `tbl()`. Never from a request field.
- A tool added to the Python server gets its twin in `lib/mcpServer.ts`: same
  name, arguments and result shape. `mcp_parity.py` will tell you if they
  disagree.
- Query ordering is part of the contract. Both sides `ORDER BY` fully, so
  results are identical rather than equal-as-sets.
- Source text is never written to the database.

**Tests:** `~/cgvenv/bin/pytest` (the loader and token tests need a Postgres
that allows `CREATE DATABASE`). The app has no unit tests yet. It was
verified end to end: login flow, previews, MCP over the Python MCP client,
parity, tenant isolation (a second tenant's token sees an empty graph), TLS
with a private CA (no CA fails, right CA connects, wrong CA refused), and the
read-only role.

---

## Build log

| Date | Commit | Change |
|---|---|---|
| 2026-09-25 | `db10d0a` | CURRENT_STATE.md baseline |
| 2026-09-25 | `6dced06` | control plane and SQLite loader |
| 2026-09-25 | `7688349` | tenant-aware app, owner login, source providers |
| 2026-09-25 | `3cd7d69` | `/api/mcp` in the app, native/proxy, token and parity scripts |
| 2026-09-25 | `3f379af` | database TLS verified against a configured CA |
| 2026-09-25 | `3ca0fe0` | Vercel functions in `syd1` |
| 2026-09-25 | this commit | FUTURE_STATE.md, this guide, switchable `.mcp.json` |
| 2026-09-26 | `99d65da` | moved to Supabase `rryfmnktebyvfxaftvyv` (`ap-southeast-1`); Vercel functions in `sin1`; loader `--exclude` |
| 2026-09-28 | `7a21111` | `tests/diagnostics/`; production live on `code-graph-viz.vercel.app`, tracking this branch |
| 2026-10-04 | `feature/graph-etl` | sign-in with GitHub and approvals; fine-grained GitHub tokens and repo connections on `/settings`; cloud indexer on AWS Lambda (daily, on push, on demand) deployed by GitHub Actions; CI workflow |
