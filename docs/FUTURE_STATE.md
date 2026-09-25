# Future state — code graph as a multi-user cloud app

Where this project is going, and which parts of it already exist. The starting
point is [CURRENT_STATE.md](CURRENT_STATE.md); how to build and run what exists
is in [ADMIN_GUIDE.md](ADMIN_GUIDE.md).

A visual version of this page: [Code Graph Cloud Architecture](https://claude.ai/artifact/Ju4oQ48AfvJ5wcChPCYPa7)
(private to the owner). This file is the source of truth.

**Status key:** **Built** = on this branch, tested. **Designed** = decided here,
not built. Anything marked designed may change when it is built; update this
file when it does.

---

## The goal in one paragraph

People sign in with Google or GitHub from a landing page. The owner approves
them in an admin portal, which gives each approved user a **logically separate
graph**: their own Postgres schema on Supabase. They choose which of their
repositories to index. Their Claude Code connects to one MCP URL with a
personal token, and that token can only ever reach their own graph.

---

## Architecture

```
                         ┌──────────────────────────── Vercel (syd1) ─────────────────────────────┐
  Browser ──────────────▶│ Next.js app (frontend/)                                                 │
  (landing, graph page,  │   pages: /login [built]  / graph [built]  /admin [designed]             │
   admin portal)         │   getViewer()  ── the one auth seam: owner cookie now, Supabase Auth later
                         │                                                                          │
  Claude Code ──Bearer──▶│   /api/mcp   token ─sha256─▶ control.mcp_tokens ─▶ tenant ─▶ schema      │
  (.mcp.json)            │     MCP_BACKEND=native  tools in-app (lib/mcpServer.ts)       [built]    │
                         │     MCP_BACKEND=proxy   forward to Python container            [built]    │
                         │                                                                          │
                         │   source text: SOURCE_PROVIDER = github | mcp | none           [built]    │
                         └───────────────┬──────────────────────────────────┬───────────────────────┘
                                         │ pg (TLS, CA-verified)            │ GitHub contents API
                                         ▼                                  ▼
                 ┌──────────── Supabase Postgres (ap-southeast-2) ───────┐  GitHub
                 │ control.tenants / mcp_tokens / repo_connections [built]│
                 │ control.users / members / index_jobs / audit [designed]│
                 │ tenant_owner.{repos,nodes,edges,files,imports} [built] │
                 │ tenant_<user>.{…same five tables…}          [designed] │
                 └───────────────────────────▲────────────────────────────┘
                                             │ writes graphs
                 ┌───────────────────────────┴────────────────────────────┐
                 │ Indexer worker: the Python code on a free container     │
                 │ clones a repo, indexes into tenant_<x>, deletes clone   │  [designed]
                 └─────────────────────────────────────────────────────────┘
```

### The four planes

| Plane | What it holds | Where | Status |
|---|---|---|---|
| **Identity** | who a person is | Supabase Auth (Google, GitHub) | designed |
| **Control** | tenants, members, tokens, repo connections, jobs, audit | `control` schema | tenants, tokens, repo connections built |
| **Data** | one graph per tenant | `tenant_<slug>` schemas | built for the owner |
| **Compute** | serving (MCP + page), indexing | Vercel; a free container for the indexer | serving built; indexing designed |

---

## Decisions already made (and built)

1. **A tenant is a Postgres schema.** `tenant_<slug>` holds the same five
   tables the indexer has always written, so the graph code needs no tenant
   column anywhere. The Python side points `search_path` at the schema; the
   TypeScript side schema-qualifies every table through `tbl()`, which only
   accepts names matching `^tenant_[a-z0-9_]{1,40}$`.
2. **The control plane is separate from graph data.** Configuration that must
   survive a reindex lives in `control`, never on the graph's own tables
   (`index_full` deletes and recreates `repos` rows).
3. **One token, one tenant.** MCP bearer tokens are random 256-bit values;
   only their SHA-256 is stored. The token alone decides the schema, and no
   tool argument can name another one.
4. **Same MCP contract, two backends.** The Next.js tools mirror the Python
   ones: same names, arguments, descriptions and result shapes. `MCP_BACKEND`
   switches between them without clients changing their URL.
   `scripts/mcp_parity.py` checks that they give the same answers.
5. **The browser never names a GitHub repo.** It sends a graph repo name. The
   server maps it through the tenant's own `repo_connections` row.
6. **Supabase's client API cannot reach any of it.** `anon` and
   `authenticated` are revoked on `control` and every `tenant_*` schema. The
   app connects server-side only, with CA-verified TLS.

---

## What is designed, not built

### 1. Sign-in and the landing page

- A public landing page at `/` for signed-out visitors. The graph moves to
  `/graph`. The page has "Continue with Google" and "Continue with GitHub",
  both through **Supabase Auth**.
- `getViewer()` (`frontend/lib/viewer.ts`) is the only function that changes.
  It reads the Supabase session instead of the owner cookie, then looks up
  the user's membership (below). Route handlers already call nothing else, so
  none of them change.
- The owner password login stays as a break-glass path until the owner's own
  Google account is linked, then is switched off (`OWNER_PASSWORD` unset).

### 2. Provisioning

Signing in does **not** give anyone a graph. The owner decides.

```
sign in ──▶ control.users row, status 'pending' ──▶ owner approves in /admin
        ──▶ provision: tenants row + tenant_<slug> schema + members row (role owner)
        ──▶ user connects GitHub repos ──▶ index jobs ──▶ user mints an MCP token
```

New control tables:

```sql
control.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text,
  status        text NOT NULL DEFAULT 'pending'   -- pending | active | suspended
                CHECK (status IN ('pending','active','suspended')),
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,
  approved_by   uuid REFERENCES control.users(id)
);

control.members (                       -- who may use which tenant
  tenant_id  bigint REFERENCES control.tenants(id) ON DELETE CASCADE,
  user_id    uuid   REFERENCES control.users(id)  ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (tenant_id, user_id)
);

control.audit_log (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
  actor uuid, action text NOT NULL, tenant_id bigint, detail jsonb
);
```

- A tenant is 1:1 with a user at first (a personal graph). `members` already
  allows a team tenant later without another schema change.
- `mcp_tokens` gains `user_id` (who minted it), so revoking a person also
  revokes their tokens.
- Provisioning reuses today's code. `control.upsert_tenant` and
  `control.ensure_tenant_schema` are exactly what the loader calls now.
- Slugs are generated, not chosen by the user (for example `u_` plus 10
  characters of their id), so a display name never reaches a schema name.
- `SessionPayload.role` already carries `owner | admin | member`.
  Platform-admin rights (`is_platform_admin`) are separate from tenant roles:
  the owner is both.

### 3. The admin portal (`/admin`, platform admins only)

| Page | Shows | Actions |
|---|---|---|
| Users | pending, active, suspended; sign-in provider; last seen | approve (provisions), suspend, delete (drops schema) |
| Tenants | schema, repos, node and edge counts, size on disk, last index | reindex, delete |
| Tokens | every token: prefix, label, tenant, last used | revoke |
| Jobs | index jobs with status and error | retry, cancel |
| Audit | every approval, suspension, token, deletion | — |

Suspending a user sets `status = 'suspended'` on the user and their tenant.
`tenantByToken` and `tenantBySlug` already refuse suspended tenants, so MCP
access stops within the 60-second tenant cache.

### 4. Choosing repos and indexing them

- **GitHub App**, not personal tokens. A user installs the app on the repos
  they choose, so GitHub itself enforces which repos are visible.
  `repo_connections` gains `installation_id`. Google-only users connect GitHub
  from their settings page before they can add repos.
- `control.index_jobs (id, tenant_id, repo_name, external_repo, git_ref,
  status, commit_sha, error, created_at, started_at, finished_at)`.
- **The worker is the existing Python indexer**, packaged on a free container
  host (Fly.io, Render, Cloud Run, Koyeb: any that runs a Docker image). It
  claims jobs with `SELECT … FOR UPDATE SKIP LOCKED`, fetches a short-lived
  installation token, shallow-clones into a temp directory, indexes into
  `tenant_<slug>` (search_path per job), records `commit_sha`, deletes the
  clone. The 500 MiB memory discipline already holds: one parse tree at a
  time.
- **Snippets stay correct.** After a successful job, the worker sets
  `repo_connections.git_ref` to the indexed `commit_sha`. Source previews
  then read the exact version the line numbers came from. Today that
  pinning is manual, and `mcp_parity.py` reports it as "source drift" when it
  is wrong.
- Re-indexing on push (a GitHub webhook that enqueues a job) comes after this.

### 5. The Python MCP server behind the gateway

When the Python server runs on that container, `/api/mcp` can switch to
`MCP_BACKEND=proxy`, keeping the client URL. The gateway has already
authenticated the tenant and sends `x-code-graph-tenant: <slug>`. The Python
server then:

- trusts that header only on requests carrying the gateway's own upstream
  token, and
- sets `search_path` per request from it.

Until it does, proxy mode refuses every tenant but the owner. That rule is
built, in `frontend/app/api/mcp/route.ts`.

---

## Security model, stated plainly

- **Isolation is enforced by the app, not the database.** The app connects as
  one role that can see every schema. What keeps tenants apart is that the
  schema comes only from the token or session (never a request field) and
  that `tbl()` validates it. **Hardening option** for when there are real
  users: one Postgres role per tenant, granted only its own schema, with the
  app running `SET ROLE` per request. A bug in a query would then fail
  instead of leaking.
- **Tokens:** hashed, shown once, revocable, `last_used_at` recorded. Add
  expiry and per-token rate limits before opening sign-ups.
- **Source text is never stored.** It is read from GitHub with the app's
  credentials (later, the user's installation token), per request.
- **The indexer runs untrusted repositories' files through parsers**, never
  executes them. Keep it that way: no build steps, no `npm install` of indexed
  repos.

## Limits worth knowing before opening sign-ups

| Limit | Value | Consequence |
|---|---|---|
| Supabase free database | 500 MB | a medium repo is ~5–20 MB of graph; cap repos per user |
| Supabase pooler connections | small on free tier | `PGPOOL_MAX=1` on Vercel |
| Vercel Hobby function time | 20 s set here (60 max) | `trace_call_path` is capped at 500 nodes |
| GitHub API, unauthenticated | 60 requests/hour | always set `GITHUB_TOKEN` (later: installation tokens) |
| Schemas per database | thousands are fine | not a concern at this scale |

## Order of work

1. **Now (built):** owner-only cloud app with the MCP endpoint, Supabase
   graph, GitHub previews. See ADMIN_GUIDE.md.
2. Supabase Auth plus the landing page; `getViewer()` switches over; the
   owner links their account.
3. `control.users` and `members`, the pending → approve flow, and `/admin`
   Users and Tokens.
4. GitHub App, the index job queue, and the Python worker on a container.
   `/admin` Jobs.
5. Per-request tenant in the Python server; proxy mode for all tenants.
6. Hardening: per-tenant roles, token expiry, rate limits, quotas.
