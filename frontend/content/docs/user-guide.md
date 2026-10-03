## Introduction

ContextForge turns a codebase into a **graph**: files, classes, functions and methods are nodes, and the relationships between them (a file imports a module, a function calls another, a class inherits from a base) are edges. That graph is stored in Postgres and served two ways:

- the **graph explorer**, a web view for people, and
- an **MCP endpoint**, for AI coding agents such as Claude Code.

The problem it addresses is context. To answer "what calls this function?" an agent without a graph searches the codebase and reads file after file. With the graph it makes one tool call and gets back a short, structured list. The graph provides the structure; the agent does the reasoning. ContextForge has no model of its own and no chat.

ContextForge stores **structure only**. Your source text is never written to its database; previews and snippets are read fresh from the source each time.

## Concepts

### Repositories

A repository is indexed under a **name** you choose, for example `my-service`. Every node and edge belongs to one repository, and every tool accepts an optional `repo` argument to scope a query to it. Each repository records when it was last indexed and how many nodes, edges and files it holds.

### Nodes

| Kind | What it is |
|---|---|
| `File` | A source or template file |
| `Class` | A class (Python, JavaScript, TypeScript) |
| `Function` | A function, including nested functions, arrow functions assigned to constants, and functions inside IIFEs |
| `Method` | A method of a class |
| `Interface` | A TypeScript interface |
| `Config` | A data or configuration file: JSON, YAML, TOML, `.env`, Dockerfile and similar |
| `Service` | A service in a Docker Compose file |

### Edges

| Type | Meaning |
|---|---|
| `CONTAINS` | Nesting: a file contains a class, a class contains a method |
| `IMPORTS` | A file imports a module or file: Python and JS imports, HTML `<script>`/`<link>`, CSS `@import`, Jinja `extends`/`include`, npm dependencies, Compose `depends_on` |
| `CALLS` | A function or method calls another |
| `INHERITS` | A class extends another |
| `IMPLEMENTS` | A TypeScript class implements an interface |
| `USES_TYPE` | A symbol uses another as a type |

### Qualified names

Tools address symbols by **qualified name**. For code files it is the dotted, extension-stripped path followed by the symbol: `src/code_graph/indexer.py` → `src.code_graph.indexer`, and its method `index_full` in class `Indexer` is `src.code_graph.indexer.Indexer.index_full`. Trailing `__init__` and `index` path segments are dropped, the way imports refer to them. HTML, CSS and configuration files keep their repository-relative path, such as `templates/base.html`.

If you do not know a qualified name, find it with `search_symbol`.

### Resolved and unresolved

When a function calls `helper()`, the indexer resolves that name to a real node through a cascade, stopping at the first match:

1. the file's own imports,
2. `self`/`cls`/`this`: a member of the enclosing class,
3. the same file,
4. a single symbol of that name anywhere in the repository.

If none applies, the call is recorded as **unresolved**, with the raw text of the call. ContextForge never guesses. Calls into libraries (`os.path.join`, `con.close`) are usually unresolved because the library is not in the graph.

## Supported languages

| Files | What is extracted |
|---|---|
| `.py` | Files, classes, functions, methods; imports, calls, inheritance, type use |
| `.js` `.jsx` `.mjs` `.cjs` | Files, classes, functions (including nested and IIFE-wrapped), methods; ES, `require` and dynamic imports; calls; `extends` |
| `.ts` `.tsx` | All of the above, plus `interface` nodes and `implements` edges |
| `.html` `.htm` `.jinja` `.j2` | File node; `<script src>` and `<link href>` dependencies, including absolute `/static/…` paths; Jinja `{% extends/include/import/from %}` and `{% macro %}` definitions and uses |
| `.css` | File node; `@import` dependencies |
| `.json` | Config node; `package.json` npm dependencies |
| `.yaml` `.yml` | Config node; Docker Compose services and `depends_on` |
| `.toml` `.xml` `.ini` `.cfg` `.env`, `Dockerfile`, `Makefile`, dotfiles | A searchable `Config` node |

References resolve **across** languages: an HTML page links to the scripts and stylesheets it loads, a JavaScript `import './x.css'` links to the CSS file, and a Compose service links to the services it depends on.

## Indexing a repository

### Where repositories come from

Indexing runs in the **self-hosted** stack. The MCP server reads repositories from the directory mounted at `/workspaces` (`REPOS_HOST_PATH` in `.env`), read-only. Any repository under that directory can be indexed; cloning a new one there makes it indexable immediately, with no restart.

Connecting repositories from GitHub and indexing in the cloud are [planned](/roadmap). The hosted deployment does not index.

### Index

```text
index_repository(name="my-service", path="my-service")
```

- `name`: letters, digits, `.`, `_` and `-`.
- `path`: relative to `/workspaces`. Paths that escape the mount are refused.

A full index replaces any previous index under that name. It returns a summary:

```json
{ "repo": "code-graph-mcp", "status": "indexed", "files_indexed": 120, "files_skipped": 1, "files_deleted": 0, "nodes": 635, "edges": 3663 }
```

### What is skipped

- Dot-directories (`.git`, `.venv`, …) and `__pycache__`, `node_modules`, `venv`, `env`, `dist`, `build`, `.eggs`, `site-packages`, `coverage`, `bower_components`, `vendor`, `target`.
- Files larger than `MAX_FILE_BYTES` (1.5 MB by default).
- A file that cannot be parsed is skipped on its own; the rest of the repository still indexes.

### Re-index

```text
reindex_repository(name="my-service")
```

Only files whose content hash changed are re-parsed; files that were deleted are dropped, and calls are re-resolved across the repository. Re-indexing is on demand. Nothing watches your files, so run it after pulling or editing.

### Verify

```text
list_repositories()
```

```json
{ "result": [{ "name": "code-graph-mcp", "path": "…/code-graph-mcp", "indexed_at": "2026-09-27T22:17:29+00:00", "node_count": 635, "edge_count": 3663, "file_count": 120 }] }
```

(`path` is shortened here; it is the path you indexed, relative to `/workspaces`.)

Then spot-check with a query you know the answer to, such as `search_symbol("main")`.

### Indexing is light

The indexer holds one parse tree in memory at a time and commits in batches. In the project's own measurements it peaked at 122 MiB indexing a 700+ file, 75k-edge repository, against the container's hard 500 MiB limit.

## Exploring the graph

The explorer is at `/graph` and needs you to sign in. Choose a repository, search for a symbol, filter by node and edge type, and click any node to open its **Symbol**, **File** and **Connections** tabs. See the [graph explorer guide](/docs/explorer).

## Working with AI agents

Agents connect to the MCP endpoint with a bearer token and get seven read tools (nine when self-hosted, including indexing). The [agents guide](/docs/agents) covers setup and workflows, and the [tool reference](/docs/api) documents each tool.

## Security and data

What is stored, what is not, and who can reach a graph: see [security and data handling](/docs/security).

## Limitations

What ContextForge does not do yet, including hosted indexing, branches and history: see [limitations](/docs/limitations).

## Troubleshooting

Common failures and fixes: see [troubleshooting](/docs/troubleshooting).
