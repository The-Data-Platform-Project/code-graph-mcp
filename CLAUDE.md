# CLAUDE.md

Project context for Claude Code. See [README.md](README.md) for the full write-up.

## What this is

A persistent, containerized **code knowledge graph** served over MCP. It parses
repositories with tree-sitter into a **Postgres** graph of files, symbols,
imports and call chains, then answers structural questions (callers, callees,
call paths, dependencies, symbol search) as MCP tools — one graph query instead
of grep/read chains. A Next.js app (`frontend/`) reads that graph and deploys to
Vercel. No egress from the indexer; hard 500 MiB cap on the MCP container.

**The split that shapes the architecture:** graph *structure* lives in Postgres
and is readable from anywhere. Source *text* is never stored — it is read fresh
from `/workspaces`, which exists only on the user's machine. So a hosted app can
browse the graph without the tunnel, but any preview of real code needs the
container.

## Runtime & environment (important)

Docker is **not** on the Windows host — it runs inside WSL2 (Ubuntu, `ismail`).
Everything Docker/pytest runs via `wsl -e bash -lc "..."`.

- Project path in WSL: `/mnt/f/The Data Platform Project/Code Graph/code-graph-mcp` (F: → `/mnt/f`).
- Dev venv (deps + pytest): `~/cgvenv`. Run tests: `cd '/mnt/f/The Data Platform Project/Code Graph/code-graph-mcp' && ~/cgvenv/bin/pytest`.
- Service: `docker compose up -d`; endpoint `http://127.0.0.1:8765/mcp` (reachable from Windows via WSL localhost forwarding). `.mcp.json` wires it to Claude Code.
- `.env` sets `REPOS_HOST_PATH=/mnt/f`, so the whole drive mounts read-only at `/workspaces`; repos are indexed by path relative to `/mnt/f` (e.g. `index_repository("data-platform", "DataPlatform/data-platform")`).
- The graph persists in the `pgdata` named volume (Postgres 16) across rebuilds.
  Inspect: `docker compose exec postgres psql -U codegraph -d codegraph`.
- Four services: `postgres`, `code-graph-mcp` (8765), `app` (3000, Next.js),
  `ngrok` (4040 inspector). Compose refuses to start without `POSTGRES_PASSWORD`
  and `CODE_GRAPH_TOKEN`.
- Tests need a Postgres: `TEST_DATABASE_URL` (each test gets its own schema).
- `scripts/setup_db.sh --docker` creates the schema in the compose container
  (no password — `docker exec psql` uses the container's trusted local socket),
  creating the database first if it is not there, so an existing Postgres
  container from another project can host the graph (`--container NAME`);
  `--supabase` or `--host/--user/--db` for a remote one. `scripts/check_db.py`
  diagnoses a connection (IPv6-only host, pooler username, missing schema).
- `scripts/push_to_supabase.sh` copies the local graph up, running `pg_dump |
  psql` entirely inside the container (the host needs no Postgres client). It
  truncates the five tables on the target first — `nodes`/`edges` key on a
  serial id, so appending would duplicate the graph — then resets the id
  sequences and verifies row counts.
- Browser UI: `http://127.0.0.1:3000/` — the Next.js app (`frontend/`). The
  container also still serves the standalone `visualizer/index.html` at
  `http://127.0.0.1:8765/` as a zero-dependency fallback; the two share
  `lib/render.js`, but the React panel is a separate implementation, so a UI
  change may need making twice. Prefer the app.
- Pass multi-line/JSON to WSL via script files, not inline heredocs (quoting gets mangled).

## Architecture

`frontend/` is the Next.js app: `lib/db.ts` queries Postgres directly,
`lib/mcp.ts` calls the container for source text, and `GRAPH_SOURCE=mcp` makes
it route graph reads through the container too (how a Vercel deploy works before
Supabase). `lib/render.js` is lifted verbatim from `visualizer/index.html` so the
markdown/highlighting stays identical to the version under test.

### `src/code_graph/`

- `server.py` — FastMCP tools + the workspaces trust boundary (`safe_join`). Also
  registers the visualizer's HTTP routes and wraps the whole ASGI app in
  `TokenAuthMiddleware` (`main()` builds the app itself rather than calling
  `mcp.run()`, because `/mcp` is a mount and cannot be gated route-by-route).
- `web.py` — the browser UI's routes: `/` (serves `visualizer/index.html`),
  `/api/graph`, `/api/readme`, `/api/node`, `/api/file`. Same-origin by design, so
  no CORS headers anywhere. `route_specs(config, connect)` returns declarative
  specs, so tests mount the same handlers on a bare Starlette app.
- `graph_export.py` — the `{nodes, links, repos, stats}` payload, shared by
  `/api/graph` and `visualizer/export_graph.py` so the live and static views
  cannot drift.
- `indexer.py` — `os.walk` generator → per-file parse → extract → buffer → batched commit → discard tree. One tree in memory at a time (the load-bearing memory discipline). `reindex` is content-hash incremental.
- `languages.py` — filename/extension → `LanguageSpec` registry. `spec_for(rel)` resolves basename first (Dockerfile/dotfiles), then extension. A spec may be **grammar-less** (`grammar_module=None` → extractor called with `tree=None`); `language_symbol` names a non-default grammar entry (TS).
- `naming.py` — the shared file-qname scheme. **Code files** (`.py/.js/.ts/...`) → dotted, extension-stripped qname (`src/app/util.js` → `src.app.util`); **everything else** → repo-relative path. `resolve_ref`/`js_import_module` compute cross-file targets by path arithmetic (no FS access).
- `extractors/` — `python.py`, `javascript.py` (JS+TS), `html.py`, `jinja.py`, `css.py`, `json.py`, `yaml.py`, `generic.py`. Each returns a `FileResult(nodes, edges, imports)` and must not retain the tree. `javascript.py` treats **anonymous function scopes (IIFEs, callbacks) as transparent** — nested named defs attribute to the nearest named container — so IIFE-wrapped modules still yield nodes. `jinja.py` is a regex pass (no grammar) invoked by `html.py`: `{% macro %}` → `Function` node, `{% extends/include/import/from %}` → template `IMPORTS`, macro uses → `CALLS` (restricted to known bindings).
- `resolver.py` — resolves `CALLS/INHERITS/IMPLEMENTS/USES_TYPE` raw strings to real nodes via a cascade: import-map → self/cls/this → same-module → unique-in-repo → honestly unresolved. Also resolves root-relative asset/template `IMPORTS` (`/static/app.js`, Jinja `{% extends "base.html" %}`) by a unique trailing-path (suffix) match, updating both the `imports` row and the edge. Runs after the whole repo is indexed.
- `db.py` — Postgres schema + `connect(dsn)`. DDL runs once per process per DSN.
- `queries.py` — read-side queries backing the tools, plus the preview side:
  `get_repo_readme`, `get_file_source`, `get_dependents`, `get_file_symbols` and
  `get_node_context` (one call returning a node, its source and everything it is
  wired to). A caller-supplied path is confined to the *repo* root, not merely to
  the workspaces mount. `models.py` — Node/Edge/Import + kind/edge constants.
  `config.py` — env config (`DATABASE_URL`, `CODE_GRAPH_TOKEN`).

## Postgres conventions (read before touching SQL)

- Placeholders are `%s`, never `?`. Rows come back as **dicts** (`dict_row`), so
  `row[0]` fails — alias counts (`COUNT(*) AS n`) and read `row["n"]`.
- `executemany` lives on the cursor, not the connection: `with con.cursor() as cur`.
- **`ILIKE`, not `LIKE`, for symbol search.** SQLite's LIKE was case-insensitive;
  Postgres' is not, so plain LIKE would silently narrow every search. Paths keep
  case-sensitive `LIKE`.
- Upserts are `ON CONFLICT (...) DO UPDATE SET x = EXCLUDED.x`.
- There is no `rowid`; address `imports` rows by `(repo, file_path, local_name)`.
- The resolver's edge scan uses a **server-side cursor** (`con.cursor(name=...)`).
  A client-side cursor buffers every row at execute time, which would break the
  memory discipline on a large repo.

## Graph model

- Node kinds: `File`, `Class`, `Function`, `Method`, `Interface`, `Config` (data/config files), `Service` (compose services).
- Edge types: `CONTAINS`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `USES_TYPE`.
- DB stores **structure only** — never source text; `get_code_snippet` reads fresh from disk.

## Languages indexed

Python and JS/TS (JSX/TSX) get a full symbol + call graph (incl. nested/IIFE
functions). HTML/Jinja templates (`<script>`/`<link>` deps incl. absolute
`/static/…`; `{% extends/include/import/from %}` template lineage; `{% macro %}`
defs + uses), CSS (`@import`), JSON (`package.json` npm deps), YAML (docker-compose
services + `depends_on`), and arbitrary config files (grammar-less `Config` node).
Cross-file references resolve across languages (HTML→JS/CSS, JS→CSS asset import,
CSS→CSS, template→template, template→macro, service→service).

## Adding a language

Add the grammar to `requirements*.txt`, write an extractor in `extractors/`, add
one `LanguageSpec` line in `languages.py`. Use `language_symbol=` for a non-default
grammar entry, or `grammar_module=None` for a grammar-less/heuristic format.

## Conventions

- Grammar wheels are pinned individually; the image builds from `requirements.lock.txt` (runtime never fetches). JSON/TOML/XML/ini are handled grammar-lessly (stdlib `json` for package.json; a generic file-node extractor otherwise).
- ruff, line-length 100, target py311.
- Keep the per-file memory discipline: never hold more than one parse tree; buffers hold plain tuples, not tree refs.
- The visualizer is one self-contained `index.html` — no build step, and no CDN
  beyond the d3 tag already there. Its markdown renderer and syntax highlighter
  are deliberately small and hand-written; escape first, then add markup.
- A missing grammar or a single unparseable file must **skip that file**, never abort a repo index.
