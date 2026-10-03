ContextForge's programmatic interface is its MCP server. There's no separate REST API. The `/api/*` routes behind the explorer are internal to the web app, they need a browser session, and they can change without notice, so please don't build on them.

## Protocol

| | |
|---|---|
| Transport | MCP streamable HTTP |
| Self-hosted endpoint | `http://127.0.0.1:8765/mcp` |
| Hosted endpoint | `https://<your-deployment>/api/mcp` |
| Authentication | `Authorization: Bearer <token>` on every request (see [agents](/docs/agents)) |
| Server name | `code-graph` |

### Result shapes

Most tools return a list. A list comes back as one text item per element, plus `structuredContent` shaped like `{"result": [ … ]}`.

`trace_call_path`, `get_code_snippet` and the indexing tools return an object instead, which comes back as one text item plus `structuredContent` equal to the object.

Errors in the input, like an unknown repository or a bad `direction`, come back as a normal result with an `"error"` field rather than as a protocol fault.

The hosted and self-hosted servers return the same names, arguments and shapes, and the project checks that with `scripts/mcp_parity.py`.

## Read tools

These are available self-hosted and hosted. Every read tool takes an optional `repo` to scope or disambiguate the query. Without it, every repository in the graph is searched.

### list_repositories

Lists the indexed repositories with their counts. It takes no arguments and returns a list of `{ name, path, indexed_at, node_count, edge_count, file_count }`.

### search_symbol

Finds functions, methods, classes and interfaces by name.

| Argument | Type | Default | Notes |
|---|---|---|---|
| `pattern` | string | required | A substring, or a glob with `*` and `?` |
| `repo` | string | all | |
| `limit` | integer | 100 | Clamped to 1–1000 |

Returns a list of `{ repo, kind, name, qualified_name, file_path, start_line, signature }`. Matching isn't case-sensitive.

### get_callers

Finds the functions and methods that call a symbol.

| Argument | Type | Notes |
|---|---|---|
| `qualified_name` | string | For example `pkg.mod.Class.method` |
| `repo` | string | Optional |

Returns a list of `{ repo, kind, qualified_name, file_path, start_line, signature }`. Only resolved calls are included, since an unresolved call has no target to match against.

### get_callees

Lists what a symbol calls, resolved or not.

| Argument | Type | Notes |
|---|---|---|
| `qualified_name` | string | The caller |
| `repo` | string | Optional |

Returns a list of `{ repo, callee, resolved, kind, file_path, start_line, signature }`, with resolved entries first. For unresolved entries, `callee` is the raw call text and the location fields are `null`.

### trace_call_path

Walks the call graph breadth-first from one symbol.

| Argument | Type | Default | Notes |
|---|---|---|---|
| `qualified_name` | string | required | The starting symbol |
| `direction` | string | `callees` | `callees` (downstream) or `callers` (upstream) |
| `depth` | integer | 3 | Clamped to 1–20 |
| `repo` | string | all | |

Returns `{ root, direction, depth, repo, nodes_visited, truncated, tree }`, where `tree` is nested `{ qualified_name, children }`. The walk is cycle-safe and stops at 500 nodes in total or 50 children per node, and `truncated` tells you whether it hit a limit.

### get_dependencies

Lists a file's imports.

| Argument | Type | Notes |
|---|---|---|
| `file_path` | string | Repository-relative, for example `pkg/module.py` |
| `repo` | string | Optional |

Returns a list of `{ repo, local_name, target, kind, in_project }`. `in_project` is true when the target is a node in the graph.

### get_code_snippet

Returns the source of one symbol.

| Argument | Type | Notes |
|---|---|---|
| `qualified_name` | string | |
| `repo` | string | Optional |

Returns `{ found, repo, qualified_name, kind, file_path, start_line, end_line, signature, code }`, or `{ found: false, error }`. The code is read from the source at request time (your disk self-hosted, GitHub hosted), never from the database.

## Indexing tools

These are self-hosted only, since the hosted deployment has no workspace to read from.

### index_repository

Fully indexes a repository, replacing any previous index under the same name.

| Argument | Type | Notes |
|---|---|---|
| `name` | string | Letters, digits, `.`, `_`, `-` (up to 100 characters) |
| `path` | string | Relative to the `/workspaces` mount. Paths escaping it are refused. |

Returns `{ repo, status: "indexed", files_indexed, files_skipped, files_deleted, nodes, edges }`, or `{ error }`.

### reindex_repository

Re-indexes incrementally. Only files whose content hash changed are parsed again, deleted files are dropped, and calls are re-resolved.

| Argument | Type | Notes |
|---|---|---|
| `name` | string | A name you previously passed to `index_repository` |

Returns the same shape as `index_repository`, with `status: "reindexed"`.

## Examples

You'll find real calls and results for each read tool in [working with AI agents](/docs/agents#workflows).
