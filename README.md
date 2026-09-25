# code-graph-mcp

A persistent, containerized **code knowledge graph** served over MCP. It parses
your repositories with [tree-sitter](https://tree-sitter.github.io/) into a
Postgres graph of files, classes, functions, methods, imports and **call chains**,
then exposes structural queries to Claude Code as MCP tools — so a question like
*"what calls this function?"*, *"what does this page load?"* or *"what does this
file depend on?"* costs **one graph query** instead of a chain of `grep`/`read`
calls.

It indexes a whole modern repo, not just one language: **Python** and
**JavaScript/TypeScript** (full symbol + call graph, including IIFE-wrapped and
nested functions), **HTML/Jinja templates** (asset deps, template
inheritance/includes, and macro definitions + uses), **CSS** (`@import`
dependencies), **JSON/YAML** (npm dependencies, Docker Compose services), and
arbitrary **config files** (searchable file nodes). See
[Supported languages](#supported-languages).

It is a fully-owned alternative to third-party code-graph MCP tools: no telemetry,
no network egress, everything installed at build time, runs as a standing local
service bound to loopback only.

---

## Highlights

- **Tiny memory footprint.** ~45 MiB idle; peaked at **122 MiB** while indexing a
  700+ file / 75k-edge repo — against a hard 500 MiB container cap. The indexing
  pipeline processes one file at a time and never holds more than one parse tree.
- **Persistent.** The graph lives in Postgres on a named volume, so it survives
  `docker compose down` and rebuilds, and is directly inspectable with `psql`.
  It can also move to a hosted database ([Supabase](docs/SUPABASE.md)) so the
  UI can be deployed to Vercel and read it without the tunnel.
- **Multi-repo, no rebuild.** Mount one parent directory read-only; index any repo
  under it by relative path. Clone a new repo there and it's immediately indexable.
- **Honest call resolution.** A graduated cascade (imports → same-module →
  unique-name) resolves callee strings to real nodes; anything ambiguous is left
  honestly *unresolved* rather than guessed.
- **No egress by construction.** The only network code is the MCP HTTP server
  *accepting* connections. The service never makes an outbound call.

---

## Supported languages

| Files | What is extracted |
|---|---|
| `.py` | Files, classes, functions, methods; imports, calls, inheritance, type use |
| `.js` `.jsx` `.mjs` `.cjs` | Files, classes, functions (incl. arrow consts, **nested and IIFE-wrapped**), methods; ES/`require`/dynamic imports, calls, `extends` |
| `.ts` `.tsx` | The above plus `interface` nodes and `implements` edges |
| `.html` `.htm` `.jinja` `.j2` | File node; `<script src>`/`<link href>` deps (incl. absolute `/static/…`); **Jinja** `{% extends/include/import/from %}` template deps and `{% macro %}` definitions + uses |
| `.css` | File node; `@import` (and `@import url(...)`) stylesheet dependencies |
| `.json` | Config node; **`package.json`** → npm dependency edges |
| `.yaml` `.yml` | Config node; **Docker Compose** → `Service` nodes + `depends_on` edges |
| `.toml` `.xml` `.ini` `.cfg` `.env`, `Dockerfile`, `Makefile`, dotfiles, … | Searchable `Config` file node (grammar-less generic fallback) |

Cross-file references resolve *across* languages: an HTML page links to the JS
modules and stylesheets it loads, a JS bundler-style `import './x.css'` links to
the CSS file, a Jinja template links to the ones it `extends`/`includes` and the
macros it calls, and a Compose service links to the services it depends on.
Root-relative refs whose base is a web doc-root or template root (`/static/app.js`,
`{% extends "base.html" %}`) resolve by a **unique trailing-path match** — so an
app served from a subdirectory links up correctly, and an ambiguous ref is left
honestly unresolved rather than guessed.

## Architecture

| Layer | Choice |
|---|---|
| Language | Python 3.11 (`python:3.11-slim`, glibc) |
| Parsing | `tree-sitter` + per-language grammar wheels (Python, JS/TS, HTML, CSS, YAML); config formats parsed grammar-lessly |
| Storage | Postgres 16 via `psycopg`, hand-written SQL, structure-only |
| App | Next.js 15 (React 19), deployable to Vercel or run in the stack |
| MCP | official `mcp` SDK / `FastMCP`, streamable HTTP on `127.0.0.1:8765`; in the cloud, the TS SDK at the app's `/api/mcp` |
| Tenancy | one Postgres schema per tenant (`tenant_<slug>`), control plane in `control` |

```
                          docker compose (mem_limit 500m, read-only rootfs)
  Claude Code ──►  127.0.0.1:8765/mcp  ──►  FastMCP tools ─┐
                                                           │
  Browser ──►  127.0.0.1:3000  ──►  app (Next.js) ──────────┤
                                       │   │               │
                    graph structure ───┘   └── source text │
                           │                      │        │
                           ▼                      ▼        ▼
                     ┌───────────┐        ┌──────────────────────┐
                     │ postgres  │◄───────│ indexer/resolver/    │
                     │ (graph)   │        │ queries + /api/file  │
                     └───────────┘        └──────────────────────┘
                                                     │
                     /workspaces (repos, read-only) ─┘

                                  cloud (no machine of yours involved)
  Claude Code ──Bearer──►  Vercel app /api/mcp ─┐        ┌─► Supabase: control + tenant_<slug>
  Browser ──login──────►  Vercel app /         ─┴────────┤
                                                         └─► GitHub (source text, per request)
```

**The split that shapes everything:** graph *structure* lives in Postgres and
can be read from anywhere. Source *text* is never stored — locally it is read
fresh from `/workspaces`; in the cloud, from the repo's GitHub connection. The
cloud setup is in [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md).

Source layout:

```
src/code_graph/
  config.py              env-driven configuration
  db.py                  schema, WAL connection, checkpoint
  languages.py           filename/extension -> grammar/extractor registry
  naming.py              shared file-qname scheme + cross-file reference resolution
  models.py              Node/Edge/Import value types + kind/edge constants
  extractors/
    base.py              Extractor interface (grammar-less extractors get tree=None)
    python.py            Python -> nodes/edges/imports
    javascript.py        JavaScript / TypeScript (JSX/TSX)
    html.py              <script>/<link>/href dependencies
    css.py               @import dependencies
    json.py              config node + package.json npm dependencies
    yaml.py              config node + docker-compose services
    generic.py           grammar-less fallback for arbitrary config files
  indexer.py             walk + per-file pipeline + batched commits + incremental reindex
  resolver.py            graduated call-resolution cascade
  queries.py             read-side graph queries backing the tools + previews
  graph_export.py        the {nodes, links, repos, stats} graph payload
  web.py                 HTTP routes + the token gate on the whole service
  server.py              FastMCP app + tool definitions (workspaces trust boundary)
  control.py             tenants, MCP tokens, repo connections (the `control` schema)
  sqlite_import.py       load a SQLite graph into a tenant schema
  __main__.py            `python -m code_graph`

frontend/                the Next.js app — runs in the stack, deploys to Vercel
  app/api/               graph/node/readme/file (tenant-scoped), auth, mcp (MCP endpoint)
  components/            Explorer shell, graph canvas, preview panel
  lib/graph.ts           read-side graph queries (port of queries.py), schema-qualified
  lib/mcpServer.ts       the MCP tools, twin of the Python read tools
  lib/viewer.ts          who is viewing → which tenant (the auth seam)
  lib/source.ts          source text from GitHub, the container, or nowhere
  lib/mcp.ts             authenticated calls to the code-graph container
  lib/render.js          markdown + syntax highlighting (shared with visualizer/)
```

---

## Quick start

Prerequisites: Docker + Docker Compose. (On Windows, this repo was built and run
with Docker inside WSL2; the Windows-side `127.0.0.1:8765` is reachable through
WSL localhost forwarding.)

```bash
# 1. Fill in .env — it will not start without the required values.
cp .env.example .env
#   REPOS_HOST_PATH    the parent dir holding your repos (/mnt/f, ...)
#   POSTGRES_PASSWORD  anything
#   CODE_GRAPH_TOKEN   openssl rand -hex 32
#   NGROK_AUTHTOKEN    only if you want the tunnel

# 2. Build and start the stack.
docker compose up -d

# 3. Create the graph schema in the Postgres container (optional — the
#    service also creates it on first connect, this just fails early).
./scripts/setup_db.sh --docker

# 4. Check it's healthy.
docker compose ps          # postgres/mcp/app "Up (healthy)"
docker compose logs -f app
```

Four services come up:

| Service | Where | What it is |
|---|---|---|
| `postgres` | `127.0.0.1:5432` | the graph. Never tunnelled. |
| `code-graph-mcp` | `127.0.0.1:8765` | indexer, MCP tools, source reads |
| `app` | `127.0.0.1:3000` | the UI — same code that deploys to Vercel |
| `ngrok` | `127.0.0.1:4040` | public URL for `code-graph-mcp` only |

Compose **refuses to start** without `POSTGRES_PASSWORD` and
`CODE_GRAPH_TOKEN`. That is deliberate: the tunnel makes `/api/file` — which
reads out of `REPOS_HOST_PATH` — reachable from the internet, and the token is
the only thing in front of it.

Don't want the tunnel? `docker compose up -d postgres code-graph-mcp app`
leaves ngrok out, and nothing is exposed beyond loopback.

### Wire it to Claude Code

A project-scoped [`.mcp.json`](.mcp.json) is included:

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

Claude Code expands `${CODE_GRAPH_TOKEN}` from its *own* environment, not from
`.env`, so export the same value where Claude Code runs. On Windows, from WSL:

```bash
setx.exe CODE_GRAPH_TOKEN "$(sed -n 's/^CODE_GRAPH_TOKEN=//p' .env)"
```

then restart Claude Code. Without it every call gets a 401.

Open Claude Code in this directory (approve the project MCP server when prompted),
then run `/mcp` — you should see the `code-graph` server with the nine tools
below. To use it from any directory, add the same block to your user config.

Then index a repo and query it:

```
index_repository(name="my-service", path="path/relative/to/workspaces")
get_callers(qualified_name="pkg.module.function")
trace_call_path(qualified_name="pkg.module.function", direction="callers", depth=3)
```

### Deploying to the cloud

The app in `frontend/` deploys to Vercel (**Root Directory = `frontend`**) and
serves both the graph page and an MCP endpoint at `/api/mcp`, reading the graph
from Supabase and source previews from GitHub — nothing on your machine needs to
be running. Each user's graph lives in its own Postgres schema, and each MCP
token reaches exactly one of them.

Step by step — loading the graph (`scripts/load_sqlite_to_supabase.py`),
minting tokens (`scripts/mcp_token.py`), Vercel settings, and pointing Claude
Code at it by setting `CODE_GRAPH_MCP_URL` — is in
[docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md). Where it is heading (sign-in,
per-user graphs, an admin portal) is in [docs/FUTURE_STATE.md](docs/FUTURE_STATE.md).

---

## MCP tools

| Tool | Purpose |
|---|---|
| `index_repository(name, path)` | Full index of a repo. `path` is relative to `/workspaces`. Replaces any prior index of `name`. |
| `reindex_repository(name)` | Incremental re-index: re-parse only files whose content hash changed, drop deleted files, re-resolve. |
| `list_repositories()` | Indexed repos with node/edge/file counts and timestamps. |
| `search_symbol(pattern, repo=None, limit=100)` | Find functions/methods/classes/interfaces by substring or `*`/`?` glob. |
| `get_callers(qualified_name, repo=None)` | Who calls this. |
| `get_callees(qualified_name, repo=None)` | What this calls (resolved targets + honest unresolved). |
| `trace_call_path(qualified_name, direction, depth, repo=None)` | BFS over the call graph, either direction, depth-limited (1–20), cycle-safe. |
| `get_dependencies(file_path, repo=None)` | Imports of a file, each flagged in-project or external. |
| `get_code_snippet(qualified_name, repo=None)` | Source text, **read fresh from disk** (never stored in the DB). |

The cloud endpoint (`/api/mcp` on the app) serves the same tools minus the two
indexing ones, with identical arguments and results; `get_code_snippet` reads
from GitHub there.

---

## Visualizer

The service also serves a browser UI on the same port. With the container up,
open:

```
http://127.0.0.1:8765/
```

You get the force-directed graph (filter by repo, node kind and edge type,
search by symbol) plus a preview panel:

| Select | You get |
|---|---|
| A **repository** | its `README` at the repo root, rendered |
| A **file** or config node | the whole file, syntax-highlighted with line numbers |
| A **function**, method or class | **Symbol** — just its own lines; **File** — the whole file with those lines highlighted; **Connections** — what calls it, what it calls, its file's imports, the files importing it, and its siblings |

Every row under **Connections** that resolves to a real node is clickable, so
you can walk the call graph through the source rather than through the canvas.
Press <kbd>Esc</kbd> to close the panel; drag its left edge to resize it.

These previews read each file **fresh from disk** through the same
`safe_join` confinement the MCP tools use — the database still stores
structure only, never source text.

The page is served from the same origin as `/api/*`, so the API needs no CORS
headers and no other site your browser visits can read it.

<details>
<summary>Opening the page without the service</summary>

`visualizer/index.html` also works straight off disk, drawing an exported
snapshot instead of the live graph:

```bash
python visualizer/export_graph.py      # writes visualizer/graph-data.json
```

The graph renders, but previews are unavailable — reading README and source
files needs the server's access to the workspaces mount. The page says so
rather than failing silently.
</details>

---

## Graph schema

**Nodes** (`kind`): `File`, `Class`, `Function`, `Method`, `Interface`, plus
`Config` (data/config files) and `Service` (Docker Compose services) — with
qualified name, file path, line span, and signature where applicable.

**Edges** (`edge_type`): `CONTAINS` (file→class→method nesting), `IMPORTS`,
`CALLS`, `INHERITS`, `IMPLEMENTS`, `USES_TYPE`.

Two core tables — `nodes` and `edges` — both indexed on qualified name (edges on
src and dst). Small metadata tables (`repos`, `files`, `imports`) back repo
listing, content-hash incremental reindex, and resolution. The database is
**structure-only**: no source text is ever stored.

### Call resolution cascade

A raw callee string (e.g. `self.method`, `os.path.join`, `Widget`) is resolved to
a real node, most-precise first, stopping at the first hit:

1. **Import map** — the file's own imports (`from .utils import helper` → `pkg.utils.helper`).
2. **self / cls** — a member of the enclosing class.
3. **Same module** — a sibling defined in the same file.
4. **Unique in repo** — a single project-wide symbol of that name.
5. **Unresolved** — left honest; no fuzzy/similarity guessing.

Code files (`.py`, `.js`, `.ts`, ...) get a **dotted, extension-stripped**
qualified name (`src/app/util.js` → `src.app.util`), so the resolver's cascade
treats every code language uniformly. HTML/CSS/config files keep their
**repo-relative path** as the qualified name and participate only in file→file
`IMPORTS` edges (resolved by exact match). The single `naming.file_qname` helper
makes both schemes line up, so an HTML `<script src="app.js">` links to the JS
module node and `<link href="a.css">` links to the CSS file node.

The `Interface`/`IMPLEMENTS` kinds are emitted by the TypeScript extractor
(`interface`, `class ... implements`); Python emits `Class`/`INHERITS`.

---

## Memory discipline

The indexing pipeline is designed to stay well under the cap, not to rely on it:

- One file at a time: parse → extract → buffer rows → **discard the tree** → next.
- Batched commits (every 200 files); buffers hold plain tuples, not tree refs.
- The file tree is walked with an `os.walk` generator — never fully materialized.
- The cross-file registry is plain indexed Postgres lookups, not cached ASTs.
- `reindex_repository` is explicit and on-demand — no background watcher threads.

Measure it yourself:

```bash
# In-process peak RSS while indexing the Python standard library:
python scripts/memory_check.py
#   files indexed : 732   nodes: 19448   edges: 74867   peak RSS: ~40 MB
```

`tests/test_memory.py` asserts peak RSS stays under 450 MB while indexing the
stdlib, as a CI/acceptance gate.

---

## Adding a language

1. Add the grammar to `requirements*.txt` (e.g. `tree-sitter-go`).
2. Write an extractor in `src/code_graph/extractors/` implementing `Extractor`.
3. Add **one line** to the registry in `languages.py`:

```python
".go": LanguageSpec("go", "tree_sitter_go", GoExtractor),
```

Nothing else in the pipeline needs to change. Two knobs cover the awkward cases:

- **Non-default grammar symbol.** Some wheels export the `Language` under a named
  function (TypeScript ships `language_typescript`/`language_tsx`). Pass it as
  `language_symbol="language_typescript"`.
- **No grammar at all.** Pass `grammar_module=None` for a format you index by
  presence/heuristics rather than a full parse; the extractor is then called with
  `tree=None`. This backs the JSON and generic-config extractors. Extensionless
  files (`Dockerfile`) and dotfiles (`.gitignore`) are registered by exact
  basename in `_FILENAME_REGISTRY`.

---

## Security & privacy

- **Loopback only.** Compose publishes `127.0.0.1:8765:8765`; the service is
  reachable from this machine and nowhere else.
- **Token on everything.** `/mcp`, `/` and `/api/*` all require
  `Authorization: Bearer $CODE_GRAPH_TOKEN` (or `X-Code-Graph-Token`), compared
  in constant time. Only `/healthz` is open, and it reports nothing but
  `{"status":"ok"}`. This is what makes the ngrok tunnel safe to run; compose
  will not start the service without a token.
- **Read-only repos.** `/workspaces` is mounted `:ro`. Repo paths from tool
  arguments are confined to the mount (`safe_join`) — no `../` traversal or
  symlink escapes; symlinks are not followed during the walk.
- **Previews are confined to the selected repo.** `/api/file` takes a path from
  the caller, so it is confined to that repo's root rather than to the whole
  mount: `../another-repo/.env` is refused even though it sits inside
  `/workspaces`. Binary files are refused and reads are capped at 1 MB.
- **No CORS.** The `/api/*` routes send no `Access-Control-Allow-Origin`, and
  the UI is served same-origin, so a page on another site cannot read your
  code through them.
- **Hardened container.** Unprivileged user, read-only root filesystem,
  `no-new-privileges`, `tmpfs` `/tmp`.
- **No egress from the indexer.** No `requests`/`urllib`/`httpx`/`socket`
  outbound use in the service source. Grammars and SDK are installed at build
  time from pinned wheels (`requirements.lock.txt`); nothing is fetched at
  runtime. The app self-hosts its fonts at build time and loads no CDN.
- **The tunnel is opt-in.** `ngrok` is a separate service: leave it out of
  `docker compose up` and the stack is loopback-only, exactly as before.

---

## Data & persistence

The graph lives in the `pgdata` named volume. It survives `docker compose
down` and rebuilds — restart the stack and previously-indexed repos are
immediately queryable with no re-index. Inspect it directly:

```bash
docker compose exec postgres psql -U codegraph -d codegraph \
  -c "SELECT name, node_count, edge_count FROM repos;"
```

To reset the graph: `docker compose down -v` (this deletes the volume), or
`TRUNCATE repos, nodes, edges, files, imports;`.

The graph is **derived data** — it can always be rebuilt by re-indexing, which
is why the Supabase move re-indexes rather than migrating rows.

---

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.lock.txt
pip install -e .

pytest                          # unit + integration + memory tests
python scripts/memory_check.py  # peak-RSS gate against a real repo

# Drive the live server like Claude Code would:
python scripts/mcp_smoke.py                       # full end-to-end walkthrough
python scripts/call_tool.py list_repositories
python scripts/call_tool.py get_callers qualified_name=pkg.mod.func
```

Dependency versions are pinned in `requirements.lock.txt` (the exact set the image
is built and tested against); `requirements.txt` lists the direct dependencies.
