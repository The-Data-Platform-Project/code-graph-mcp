# CLAUDE.md

Project context for Claude Code. See [README.md](README.md) for the full write-up.

## What this is

A persistent, containerized **code knowledge graph** served over MCP. It parses
repositories with tree-sitter into a SQLite graph of files, symbols, imports and
call chains, then answers structural questions (callers, callees, call paths,
dependencies, symbol search) as MCP tools — one graph query instead of grep/read
chains. No network egress; loopback-only HTTP; hard 500 MiB container cap.

## Runtime & environment (important)

Docker is **not** on the Windows host — it runs inside WSL2 (Ubuntu, `ismail`).
Everything Docker/pytest runs via `wsl -e bash -lc "..."`.

- Project path in WSL: `/mnt/f/Code Graph/code-graph-mcp` (F: → `/mnt/f`).
- Dev venv (deps + pytest): `~/cgvenv`. Run tests: `cd '/mnt/f/Code Graph/code-graph-mcp' && ~/cgvenv/bin/pytest`.
- Service: `docker compose up -d`; endpoint `http://127.0.0.1:8765/mcp` (reachable from Windows via WSL localhost forwarding). `.mcp.json` wires it to Claude Code.
- `.env` sets `REPOS_HOST_PATH=/mnt/f`, so the whole drive mounts read-only at `/workspaces`; repos are indexed by path relative to `/mnt/f` (e.g. `index_repository("data-platform", "DataPlatform/data-platform")`).
- The graph persists in host `./data/graph.db` (bind mount) across rebuilds.
- Pass multi-line/JSON to WSL via script files, not inline heredocs (quoting gets mangled).

## Architecture (`src/code_graph/`)

- `server.py` — FastMCP tools + the workspaces trust boundary (`safe_join`).
- `indexer.py` — `os.walk` generator → per-file parse → extract → buffer → batched commit → discard tree. One tree in memory at a time (the load-bearing memory discipline). `reindex` is content-hash incremental.
- `languages.py` — filename/extension → `LanguageSpec` registry. `spec_for(rel)` resolves basename first (Dockerfile/dotfiles), then extension. A spec may be **grammar-less** (`grammar_module=None` → extractor called with `tree=None`); `language_symbol` names a non-default grammar entry (TS).
- `naming.py` — the shared file-qname scheme. **Code files** (`.py/.js/.ts/...`) → dotted, extension-stripped qname (`src/app/util.js` → `src.app.util`); **everything else** → repo-relative path. `resolve_ref`/`js_import_module` compute cross-file targets by path arithmetic (no FS access).
- `extractors/` — `python.py`, `javascript.py` (JS+TS), `html.py`, `css.py`, `json.py`, `yaml.py`, `generic.py`. Each returns a `FileResult(nodes, edges, imports)` and must not retain the tree.
- `resolver.py` — resolves `CALLS/INHERITS/IMPLEMENTS/USES_TYPE` raw strings to real nodes via a cascade: import-map → self/cls/this → same-module → unique-in-repo → honestly unresolved. Runs after the whole repo is indexed.
- `queries.py` — read-side queries backing the tools. `db.py` — schema/WAL. `models.py` — Node/Edge/Import + kind/edge constants. `config.py` — env config.

## Graph model

- Node kinds: `File`, `Class`, `Function`, `Method`, `Interface`, `Config` (data/config files), `Service` (compose services).
- Edge types: `CONTAINS`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `USES_TYPE`.
- DB stores **structure only** — never source text; `get_code_snippet` reads fresh from disk.

## Languages indexed

Python and JS/TS (JSX/TSX) get a full symbol + call graph. HTML (`<script>`/`<link>`
deps), CSS (`@import`), JSON (`package.json` npm deps), YAML (docker-compose
services + `depends_on`), and arbitrary config files (grammar-less `Config` node).
Cross-file references resolve across languages (HTML→JS/CSS, JS→CSS asset import,
CSS→CSS, service→service).

## Adding a language

Add the grammar to `requirements*.txt`, write an extractor in `extractors/`, add
one `LanguageSpec` line in `languages.py`. Use `language_symbol=` for a non-default
grammar entry, or `grammar_module=None` for a grammar-less/heuristic format.

## Conventions

- Grammar wheels are pinned individually; the image builds from `requirements.lock.txt` (runtime never fetches). JSON/TOML/XML/ini are handled grammar-lessly (stdlib `json` for package.json; a generic file-node extractor otherwise).
- ruff, line-length 100, target py311.
- Keep the per-file memory discipline: never hold more than one parse tree; buffers hold plain tuples, not tree refs.
- A missing grammar or a single unparseable file must **skip that file**, never abort a repo index.
