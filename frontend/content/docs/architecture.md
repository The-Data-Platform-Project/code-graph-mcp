## Overview

ContextForge has three parts. An indexer parses repositories into a graph, a Postgres database holds that graph (structure only), and two front doors read it: the graph explorer, which is a Next.js web app, and an MCP server for agents.

```text
  repository files ──► indexer ──► Postgres graph ──┬──► MCP server  ──► AI agent
   (read-only)     parse · extract ·  (structure only) │
                   resolve                           └──► web app    ──► browser
                                                          (explorer)
  source text is never stored: previews and snippets are read from the source on request
```

## Indexing pipeline

The indexer is written in Python and runs inside the self-hosted stack's `code-graph-mcp` container. Here's what happens to a repository:

1. It walks the repository directory lazily, pruning dot-directories and build or dependency folders (`node_modules`, `venv`, `dist`, `build`, `vendor`, `target`, …).
2. It parses each supported file with tree-sitter, using a pinned grammar per language. JSON and generic config files don't need a grammar.
3. A per-language extractor turns the syntax tree into nodes (files, classes, functions, methods, interfaces, config files, services), edges, and an import map. The JavaScript extractor treats anonymous scopes like IIFEs and callbacks as transparent, so named functions inside them still become nodes.
4. Rows are buffered as plain values and committed every 200 files. Each parse tree is thrown away before the next file is read, so only one tree is ever in memory.
5. Once the whole repository is in, raw call, inheritance and type references are resolved to real nodes, in this order: import map, then `self`/`cls`/`this`, then same file, then a unique name in the repository, and otherwise it's left unresolved. Root-relative asset and template references (`/static/app.js`, `{% extends "base.html" %}`) resolve by a unique trailing-path match. The resolver streams edges with a server-side cursor, so memory stays flat even on large repositories.

`reindex_repository` hashes each file's content and repeats steps 2–4 only for the files that changed, then runs resolution again.

Measured in the container, it sits at about 45 MiB idle and peaked at 122 MiB indexing a 700+ file, 75k-edge repository, under a hard 500 MiB limit.

## The graph

There are five tables, the same in every deployment:

| Table | Holds |
|---|---|
| `repos` | One row per indexed repository: path, `indexed_at`, counts |
| `nodes` | Kind, name, qualified name, file, line range, signature |
| `edges` | Type, source and target qualified names, the raw reference, whether it resolved |
| `files` | Path and content hash per file, for incremental re-indexing |
| `imports` | Each file's import bindings, used by resolution and `get_dependencies` |

None of them holds source text.

### Tenancy

Each graph lives in its own Postgres schema, `tenant_<slug>`, with those five tables inside. A separate `control` schema records the tenants, the MCP tokens (as hashes) and the repository connections. The web app qualifies every query with the schema of the signed-in tenant, or of the tenant a token belongs to, and a schema name never comes from a request parameter.

## Serving the graph

### Self-hosted

```text
  Claude Code ──Bearer──► 127.0.0.1:8765/mcp ──► MCP server (Python) ──┐
                                                                       ├──► Postgres
  Browser ──sign-in─────► 127.0.0.1:3000     ──► web app (Next.js) ────┘
                                                   │
                                  source previews ─┴─► MCP server reads /workspaces (read-only)
```

Docker Compose runs `postgres`, `code-graph-mcp` and `app`, all bound to `127.0.0.1`. The MCP container runs as an unprivileged user with a read-only root filesystem, no privilege escalation and a 500 MiB memory limit, and it makes no outbound network calls.

### Hosted

```text
  Claude Code ──Bearer cgk_…──► /api/mcp ─┐
                                          ├── Next.js on Vercel ──► Supabase Postgres (TLS, CA-verified)
  Browser ──sign-in───────────► /graph  ──┘                     └──► GitHub (source text, on request)
```

Here the web app serves both the explorer and the MCP endpoint. Its MCP tools are a TypeScript twin of the Python read tools, with the same names, arguments and results. If you set `MCP_BACKEND=proxy`, `/api/mcp` forwards to a Python server instead, and clients don't have to change their URL. The hosted deployment doesn't index. Its graphs are indexed in a self-hosted stack and loaded by the administrator.

Source previews depend on `SOURCE_PROVIDER`. With `mcp` they're read through the self-hosted MCP container, with `github` they're fetched from the repository connected to that graph, and `none` turns previews off.

## Technology

| Layer | Choice |
|---|---|
| Indexer and self-hosted MCP | Python 3.11, tree-sitter, `psycopg`, the official `mcp` SDK |
| Storage | Postgres 16 locally; Supabase Postgres when hosted |
| Web app and hosted MCP | Next.js 15, React 19, TypeScript, the MCP TypeScript SDK, d3 |
| Packaging | Docker Compose; Vercel for the hosted app |

## Adding a language

Adding a language comes down to a grammar dependency, one extractor class, and one line in the language registry (`src/code_graph/languages.py`). The rest of the pipeline doesn't change. The repository README covers the details.
