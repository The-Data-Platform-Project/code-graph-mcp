## Overview

ContextForge has three parts:

1. an **indexer** that parses repositories into a graph,
2. a **Postgres graph** that holds structure only, and
3. **two ways to read it**: the graph explorer (a Next.js web app) and an MCP server for agents.

```text
  repository files ──► indexer ──► Postgres graph ──┬──► MCP server  ──► AI agent
   (read-only)     parse · extract ·  (structure only) │
                   resolve                           └──► web app    ──► browser
                                                          (explorer)
  source text is never stored: previews and snippets are read from the source on request
```

## Indexing pipeline

Indexing is written in Python and runs inside the self-hosted stack's `code-graph-mcp` container.

1. **Walk.** The repository directory is walked lazily, pruning dot-directories and build or dependency folders (`node_modules`, `venv`, `dist`, `build`, `vendor`, `target`, …).
2. **Parse.** Each supported file is parsed with **tree-sitter**, using a pinned grammar per language. JSON and generic config files are handled without a grammar.
3. **Extract.** A per-language extractor turns the syntax tree into nodes (files, classes, functions, methods, interfaces, config files, services), edges, and an import map. JavaScript extraction treats anonymous scopes (IIFEs, callbacks) as transparent, so named functions inside them still become nodes.
4. **Buffer and commit.** Rows are buffered as plain values and committed every 200 files. Each parse tree is discarded before the next file is read, so **only one tree is ever in memory**.
5. **Resolve.** After the whole repository is in, raw call, inheritance and type references are resolved to real nodes: import map → `self`/`cls`/`this` → same file → unique name in the repository → left unresolved. Root-relative asset and template references (`/static/app.js`, `{% extends "base.html" %}`) resolve by a unique trailing-path match. The resolver streams edges with a server-side cursor, so memory stays flat on large repositories.

`reindex_repository` hashes each file's content and repeats steps 2–4 only for files that changed, then re-runs resolution.

Measured in the container: about 45 MiB idle and **122 MiB peak** indexing a 700+ file, 75k-edge repository, under a hard 500 MiB limit.

## The graph

Five tables, identical in every deployment:

| Table | Holds |
|---|---|
| `repos` | One row per indexed repository: path, `indexed_at`, counts |
| `nodes` | Kind, name, qualified name, file, line range, signature |
| `edges` | Type, source and target qualified names, the raw reference, whether it resolved |
| `files` | Path and content hash per file, for incremental re-indexing |
| `imports` | Each file's import bindings, used by resolution and `get_dependencies` |

No table holds source text.

### Tenancy

Each graph lives in its own Postgres schema, `tenant_<slug>`, holding those five tables. A separate `control` schema records tenants, MCP tokens (as hashes) and repository connections. The web app qualifies every query with the schema of the signed-in tenant, or of the tenant a token belongs to. A schema name never comes from a request parameter.

## Serving the graph

### Self-hosted

```text
  Claude Code ──Bearer──► 127.0.0.1:8765/mcp ──► MCP server (Python) ──┐
                                                                       ├──► Postgres
  Browser ──sign-in─────► 127.0.0.1:3000     ──► web app (Next.js) ────┘
                                                   │
                                  source previews ─┴─► MCP server reads /workspaces (read-only)
```

Docker Compose runs `postgres`, `code-graph-mcp` and `app`, all bound to `127.0.0.1`. The MCP container is hardened: unprivileged user, read-only root filesystem, no privilege escalation, and a 500 MiB memory limit. It makes no outbound network calls.

### Hosted

```text
  Claude Code ──Bearer cgk_…──► /api/mcp ─┐
                                          ├── Next.js on Vercel ──► Supabase Postgres (TLS, CA-verified)
  Browser ──sign-in───────────► /graph  ──┘                     └──► GitHub (source text, on request)
```

The web app serves both the explorer and the MCP endpoint. Its MCP tools are a TypeScript twin of the Python read tools, with the same names, arguments and results. `MCP_BACKEND=proxy` can forward `/api/mcp` to a Python server instead, without changing the client URL. The hosted deployment does not index: its graphs are indexed in a self-hosted stack and loaded by the administrator.

Source previews use `SOURCE_PROVIDER`: `mcp` reads through the self-hosted MCP container, `github` fetches from the repository connected to that graph, and `none` turns previews off.

## Technology

| Layer | Choice |
|---|---|
| Indexer and self-hosted MCP | Python 3.11, tree-sitter, `psycopg`, the official `mcp` SDK |
| Storage | Postgres 16 locally; Supabase Postgres when hosted |
| Web app and hosted MCP | Next.js 15, React 19, TypeScript, the MCP TypeScript SDK, d3 |
| Packaging | Docker Compose; Vercel for the hosted app |

## Extending languages

A language is a grammar dependency, one extractor class, and one line in the language registry (`src/code_graph/languages.py`). The rest of the pipeline is unchanged. The repository README covers the details.
