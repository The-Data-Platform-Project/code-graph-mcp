# Current state — baseline before the cloud migration

**Snapshot of branch `claude/hopeful-noether-ff21ui` at commit `09a488f`**, taken
before the cloud migration began. It records where every component lives and
what state it is in, so the migration has a fixed starting point. The target is
[FUTURE_STATE.md](FUTURE_STATE.md); how to build and run it is in
[ADMIN_GUIDE.md](ADMIN_GUIDE.md).

Everything below was checked against the repository. What is *running* on the
desktop is taken from the desktop session's own commit (`09a488f`, "first real
bring-up of the Postgres build on the desktop") — a cloud session cannot see the
desktop.

---

## One-paragraph summary

Almost everything runs on one Windows PC (DESKTOP-GOSVH03), inside Docker in
WSL2. The only cloud pieces are a Supabase database whose graph tables are
empty and a Vercel project pointed at the wrong directory. All of the code is on
this branch, which is **not merged** — `main` (`aa4db27`) is still the older
SQLite version — and has no pull request.

---

## Where the MCP server is

| | |
|---|---|
| Code | `src/code_graph/server.py` (FastMCP, streamable HTTP) |
| Image | `code-graph-mcp:latest`, built from `Dockerfile` |
| Runs as | container `code-graph-mcp`, Docker inside WSL2 on the desktop |
| Listens on | `127.0.0.1:8765` only — loopback, not reachable from the network |
| How Claude Code finds it | `.mcp.json` → `http://127.0.0.1:8765/mcp` with `Authorization: Bearer ${CODE_GRAPH_TOKEN}` |
| Where that token comes from | Windows environment variable, set with `setx` (not `.env`) |
| Reads source from | `/workspaces` = `REPOS_HOST_PATH` = `/mnt/f` = the whole F: drive, read-only |
| Reachable from the cloud | No. A cloud session gets `ECONNREFUSED`. |

**Tools it exposes (9):** `index_repository`, `reindex_repository`,
`list_repositories`, `search_symbol`, `get_callers`, `get_callees`,
`trace_call_path`, `get_dependencies`, `get_code_snippet`.

**HTTP routes on the same process:** `/mcp` (the MCP transport), `/` (static
visualizer), `/api/graph`, `/api/readme`, `/api/node`, `/api/file`, and
`/healthz`. Every route except `/healthz` requires the bearer token
(`TokenAuthMiddleware` in `web.py`).

---

## Where the graph database is

There are three candidates. Only one is live.

| Location | Role | Contents |
|---|---|---|
| Container `data-platform-postgres-1`, database and role `codegraph` | **Live.** Joined through the `docker-compose.external-db.yml` overlay on network `data-platform_default`. Publishes no host port. | Schema created. Whether any repository has been indexed into it is not known. |
| Supabase project `rkeuovfdmmjebechozev`, region `ap-southeast-2`, database `postgres`, schema `public` | Intended hosted copy | The five graph tables exist and are **empty**. They have never held graph data. |
| `./data/graph.db` (SQLite) | The pre-branch graph, written by the `main` version | **Orphaned.** This branch neither mounts nor reads it. It still holds whatever was indexed before this work. |

The stack's own `postgres` service (volume `pgdata`) is parked behind the
`local-db` profile on the desktop, because `.env` switches to the external-db
overlay.

The graph tables are identical in all three: `repos`, `nodes`, `edges`, `files`,
`imports` — SQLite on `main` and Postgres on this branch share the same columns.

---

## Where the UI is

| UI | Location | State |
|---|---|---|
| Next.js app (`frontend/`) | compose service `app`, `127.0.0.1:3000` | **The primary UI.** Reads graph structure directly from Postgres; fetches source text through the MCP container. |
| Static visualizer (`visualizer/index.html`) | served by the MCP container at `127.0.0.1:8765/` | **Broken in a browser.** The token gate covers `/`, and a browser cannot attach a Bearer header, so it returns 401. |
| Vercel project `code-graph-viz` | linked to `visualizer/` | **Misconfigured.** That directory has no API routes, so a deployment can only render "No graph data yet". Whether it has been deployed is not known. |

---

## Every other component

**Compose services** (`docker-compose.yml`):

| Service | Container | Port | Default |
|---|---|---|---|
| `postgres` | `code-graph-postgres` | 127.0.0.1:5432 | parked on the desktop (`local-db` profile) |
| `code-graph-mcp` | `code-graph-mcp` | 127.0.0.1:8765 | on |
| `app` | `code-graph-app` | 127.0.0.1:3000 | on |
| `ngrok` | `code-graph-ngrok` | 127.0.0.1:4040 (inspector) | off — `tunnel` profile |

`docker-compose.external-db.yml` is an overlay, enabled through `COMPOSE_FILE` in
`.env`, that parks `postgres` and joins another project's network.

**Scripts** (`scripts/`):

| Script | Purpose | State |
|---|---|---|
| `setup_db.sh` | Create the graph schema (`--docker`, `--supabase`, `--create-role`) | works |
| `check_db.py` | Diagnose a connection (IPv6-only host, pooler username, missing schema) | works |
| `push_to_supabase.sh` | Copy the local graph to Supabase in one transaction | works; never run successfully because no local graph existed |
| `index_one.py` | Index one repository from the command line | works |
| `call_tool.py` | Call an MCP tool over HTTP | works (sends the token since `09a488f`) |
| `mcp_smoke.py` | End-to-end MCP smoke test | works |
| `memory_check.py` | Peak-RSS check while indexing | works |
| `visualizer/export_graph.py` | Export a static `graph-data.json` | **broken** — still opens SQLite; missed in the Postgres migration |

**Configuration and secrets:**

- `.env` (gitignored): `REPOS_HOST_PATH`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB`, `POSTGRES_HOST`, `COMPOSE_FILE`, `EXTERNAL_DB_NETWORK`,
  `CODE_GRAPH_TOKEN`, `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`, `GRAPH_SOURCE`.
- Windows environment: `CODE_GRAPH_TOKEN`, read by Claude Code for `.mcp.json`.
- `.gitattributes` pins LF line endings (a CRLF checkout broke every shell script).

**Tests:** 88, all passing on `09a488f`. They need a Postgres, reached through
`TEST_DATABASE_URL`; each test gets its own schema.

**Documentation:** `README.md`, `CLAUDE.md`, `docs/SUPABASE.md`.

**GitHub** (`The-Data-Platform-Project/code-graph-mcp`):

| Branch | Commit | State |
|---|---|---|
| `main` | `aa4db27` | the SQLite version plus the original visualizer |
| `claude/hopeful-noether-ff21ui` | `09a488f` | all of the work described here; unmerged, no PR |
| `feature/pipeline-overhaul` | `6cf1761` | **unmerged**, predates this work, likely to conflict with it |
| `feature/template-and-nested-scope-extraction` | `caf4018` | already merged into `main` |

---

## What is broken or unverified

**Broken:**

- The static visualizer at `127.0.0.1:8765/` returns 401 in a browser.
- `visualizer/export_graph.py` opens SQLite against a Postgres-only payload
  builder.
- The Vercel project is rooted at `visualizer/` instead of `frontend/`.

**Never verified end to end:**

- Nothing has been indexed into Postgres, so no Postgres graph has been
  browsed with real data outside tests.
- `push_to_supabase.sh` has never completed a real run.
- No Vercel deployment of `frontend/` exists.

**Known debt:**

- The UI exists twice — `visualizer/index.html` and the React app. They share
  `lib/render.js`, but the panels are separate implementations.
- There are no frontend tests.
- Both database scripts default to `data-platform-postgres-1`, tying this
  repository to another project's container name.

---

## The constraint that shapes the next step

Graph *structure* lives in Postgres and can be read from anywhere. Source *text*
is never stored — it is read fresh from `/workspaces`, which exists only on the
desktop. Every step toward the cloud has to answer where source text comes
from once the desktop is out of the picture.
