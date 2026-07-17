# code-graph-mcp

A persistent, containerized **code knowledge graph** served over MCP. It parses
your repositories with [tree-sitter](https://tree-sitter.github.io/) into a
SQLite graph of files, classes, functions, methods, imports and **call chains**,
then exposes structural queries to Claude Code as MCP tools — so a question like
*"what calls this function?"* or *"what does this file depend on?"* costs **one
graph query** instead of a chain of `grep`/`read` calls.

It is a fully-owned alternative to third-party code-graph MCP tools: no telemetry,
no network egress, everything installed at build time, runs as a standing local
service bound to loopback only.

---

## Highlights

- **Tiny memory footprint.** ~45 MiB idle; peaked at **122 MiB** while indexing a
  700+ file / 75k-edge repo — against a hard 500 MiB container cap. The indexing
  pipeline processes one file at a time and never holds more than one parse tree.
- **Persistent.** The graph lives in `./data/graph.db` on a host bind mount, so it
  survives `docker compose down` and rebuilds, and is directly inspectable.
- **Multi-repo, no rebuild.** Mount one parent directory read-only; index any repo
  under it by relative path. Clone a new repo there and it's immediately indexable.
- **Honest call resolution.** A graduated cascade (imports → same-module →
  unique-name) resolves callee strings to real nodes; anything ambiguous is left
  honestly *unresolved* rather than guessed.
- **No egress by construction.** The only network code is the MCP HTTP server
  *accepting* connections. The service never makes an outbound call.

---

## Architecture

| Layer | Choice |
|---|---|
| Language | Python 3.11 (`python:3.11-slim`, glibc) |
| Parsing | `tree-sitter` + `tree-sitter-python` (grammar bundled in the wheel) |
| Storage | stdlib `sqlite3`, WAL mode, hand-written SQL, structure-only |
| MCP | official `mcp` SDK / `FastMCP`, streamable HTTP on `127.0.0.1:8765` |

```
                          docker compose (mem_limit 500m, read-only rootfs)
  Claude Code  ──HTTP──►  127.0.0.1:8765/mcp  ──►  FastMCP tools
                                                     │
                                    ┌────────────────┼─────────────────┐
                                    ▼                ▼                 ▼
                                 indexer          resolver          queries
                                    │                │                 │
                                    └──────►  SQLite graph.db  ◄────────┘
                                             (host ./data, WAL)

  /workspaces  (host repos parent, mounted read-only)  ──►  parsed on demand
```

Source layout:

```
src/code_graph/
  config.py              env-driven configuration
  db.py                  schema, WAL connection, checkpoint
  languages.py           extension -> grammar/extractor registry (1-line to add a language)
  models.py              Node/Edge/Import value types + kind/edge constants
  extractors/
    base.py              Extractor interface
    python.py            Python -> nodes/edges/imports
  indexer.py             walk + per-file pipeline + batched commits + incremental reindex
  resolver.py            graduated call-resolution cascade
  queries.py             read-side graph queries backing the tools
  server.py              FastMCP app + tool definitions (workspaces trust boundary)
  __main__.py            `python -m code_graph`
```

---

## Quick start

Prerequisites: Docker + Docker Compose. (On Windows, this repo was built and run
with Docker inside WSL2; the Windows-side `127.0.0.1:8765` is reachable through
WSL localhost forwarding.)

```bash
# 1. Point the workspaces mount at the parent dir holding your repos.
cp .env.example .env
#   edit .env: REPOS_HOST_PATH=/mnt/f        (or /home/you/src, etc.)

# 2. Build and start the standing service.
docker compose up -d

# 3. Check it's healthy.
docker compose ps          # STATUS should show "Up (healthy)"
docker compose logs        # "Uvicorn running on http://0.0.0.0:8765"
```

`GRAPH_DB_PATH` and `WORKSPACES_ROOT` are already wired in `docker-compose.yml`;
you normally only set `REPOS_HOST_PATH`.

### Wire it to Claude Code

A project-scoped [`.mcp.json`](.mcp.json) is included:

```json
{
  "mcpServers": {
    "code-graph": { "type": "http", "url": "http://127.0.0.1:8765/mcp" }
  }
}
```

Open Claude Code in this directory (approve the project MCP server when prompted),
then run `/mcp` — you should see the `code-graph` server with the nine tools
below. To use it from any directory, add the same block to your user config.

Then index a repo and query it:

```
index_repository(name="my-service", path="path/relative/to/workspaces")
get_callers(qualified_name="pkg.module.function")
trace_call_path(qualified_name="pkg.module.function", direction="callers", depth=3)
```

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

---

## Graph schema

**Nodes** (`kind`): `File`, `Class`, `Function`, `Method`, `Interface` — with
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

The `Interface`/`IMPLEMENTS` kinds exist in the schema for future languages; the
Python extractor emits `Class`/`INHERITS`.

---

## Memory discipline

The indexing pipeline is designed to stay well under the cap, not to rely on it:

- One file at a time: parse → extract → buffer rows → **discard the tree** → next.
- Batched commits (every 200 files); buffers hold plain tuples, not tree refs.
- The file tree is walked with an `os.walk` generator — never fully materialized.
- The cross-file registry is plain indexed SQLite lookups, not cached ASTs.
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

1. Add the grammar to `requirements*.txt` (e.g. `tree-sitter-javascript`).
2. Write an extractor in `src/code_graph/extractors/` implementing `Extractor`.
3. Add **one line** to the registry in `languages.py`:

```python
".js": LanguageSpec("javascript", "tree_sitter_javascript", JsExtractor),
```

Nothing else in the pipeline needs to change.

---

## Security & privacy

- **Loopback only.** Compose publishes `127.0.0.1:8765:8765`; the service is
  reachable from this machine and nowhere else.
- **Read-only repos.** `/workspaces` is mounted `:ro`. Repo paths from tool
  arguments are confined to the mount (`safe_join`) — no `../` traversal or
  symlink escapes; symlinks are not followed during the walk.
- **Hardened container.** Unprivileged user, read-only root filesystem,
  `no-new-privileges`, `tmpfs` `/tmp`.
- **No egress.** No `requests`/`urllib`/`httpx`/`socket` outbound use in the
  service source. Grammars and SDK are installed at build time from pinned wheels
  (`requirements.lock.txt`); nothing is fetched at runtime.

---

## Data & persistence

`./data/graph.db` is a host bind mount. It survives `docker compose down`,
rebuilds, and container recreation — restart the service and previously-indexed
repos are immediately queryable with no re-index. WAL is checkpointed after each
index so the host sees a single compact `graph.db`. Inspect it directly:

```bash
sqlite3 data/graph.db "SELECT name, node_count, edge_count FROM repos;"
```

To reset the graph, stop the service and delete `data/graph.db*`.

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
