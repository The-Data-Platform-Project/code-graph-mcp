ContextForge's programmatic interface is its **MCP server**. There is no separate REST API: the `/api/*` routes behind the explorer are internal to the web app, need a browser session, and may change without notice.

## Protocol

| | |
|---|---|
| Transport | MCP streamable HTTP |
| Self-hosted endpoint | `http://127.0.0.1:8765/mcp` |
| Hosted endpoint | `https://<your-deployment>/api/mcp` |
| Authentication | `Authorization: Bearer <token>` on every request (see [agents](/docs/agents)) |
| Server name | `code-graph` |

### Result shapes

- **List results** (most tools) arrive as one text item per element, plus `structuredContent` of the form `{"result": [ … ]}`.
- **Object results** (`trace_call_path`, `get_code_snippet`, the indexing tools) arrive as one text item plus `structuredContent` equal to the object.
- **Errors** in the input, such as an unknown repository or a bad `direction`, come back as a normal result containing an `"error"` field, not as a protocol fault.

The hosted and self-hosted servers return the same names, arguments and shapes; the project checks this with `scripts/mcp_parity.py`.

## Read tools

Available self-hosted and hosted. Every read tool accepts an optional `repo` to scope or disambiguate; without it, all repositories in the graph are searched.

### list_repositories

Lists indexed repositories with their counts.

**Arguments:** none.

**Returns:** a list of `{ name, path, indexed_at, node_count, edge_count, file_count }`.

### search_symbol

Finds functions, methods, classes and interfaces by name.

| Argument | Type | Default | Notes |
|---|---|---|---|
| `pattern` | string | required | A substring, or a glob with `*` and `?` |
| `repo` | string | all | |
| `limit` | integer | 100 | Clamped to 1–1000 |

**Returns:** a list of `{ repo, kind, name, qualified_name, file_path, start_line, signature }`. Matching is case-insensitive.

### get_callers

Functions and methods that call a symbol.

| Argument | Type | Notes |
|---|---|---|
| `qualified_name` | string | For example `pkg.mod.Class.method` |
| `repo` | string | Optional |

**Returns:** a list of `{ repo, kind, qualified_name, file_path, start_line, signature }`. Only resolved calls are included: an unresolved call has no target to match.

### get_callees

What a symbol calls, resolved or not.

| Argument | Type | Notes |
|---|---|---|
| `qualified_name` | string | The caller |
| `repo` | string | Optional |

**Returns:** a list of `{ repo, callee, resolved, kind, file_path, start_line, signature }`. Resolved entries come first. For unresolved entries `callee` is the raw call text and the location fields are `null`.

### trace_call_path

A breadth-first walk of the call graph from one symbol.

| Argument | Type | Default | Notes |
|---|---|---|---|
| `qualified_name` | string | required | The starting symbol |
| `direction` | string | `callees` | `callees` (downstream) or `callers` (upstream) |
| `depth` | integer | 3 | Clamped to 1–20 |
| `repo` | string | all | |

**Returns:** `{ root, direction, depth, repo, nodes_visited, truncated, tree }`, where `tree` is nested `{ qualified_name, children }`. The walk is cycle-safe and stops at 500 nodes in total or 50 children per node; `truncated` says whether a limit was hit.

### get_dependencies

A file's imports.

| Argument | Type | Notes |
|---|---|---|
| `file_path` | string | Repository-relative, for example `pkg/module.py` |
| `repo` | string | Optional |

**Returns:** a list of `{ repo, local_name, target, kind, in_project }`. `in_project` is true when the target is a node in the graph.

### get_code_snippet

The source of one symbol.

| Argument | Type | Notes |
|---|---|---|
| `qualified_name` | string | |
| `repo` | string | Optional |

**Returns:** `{ found, repo, qualified_name, kind, file_path, start_line, end_line, signature, code }`, or `{ found: false, error }`. The code is read from the source at request time (your disk self-hosted, GitHub hosted), never from the database.

## Indexing tools

**Self-hosted only.** The hosted deployment has no workspace to read from.

### index_repository

Fully indexes a repository, replacing any previous index under the same name.

| Argument | Type | Notes |
|---|---|---|
| `name` | string | Letters, digits, `.`, `_`, `-` (up to 100 characters) |
| `path` | string | Relative to the `/workspaces` mount. Paths escaping it are refused. |

**Returns:** `{ repo, status: "indexed", files_indexed, files_skipped, files_deleted, nodes, edges }`, or `{ error }`.

### reindex_repository

Re-indexes incrementally: only files whose content hash changed are re-parsed, deleted files are dropped, and calls are re-resolved.

| Argument | Type | Notes |
|---|---|---|
| `name` | string | A name previously passed to `index_repository` |

**Returns:** the same shape as `index_repository`, with `status: "reindexed"`.

## Examples

Real calls and results for each read tool are in [working with AI agents](/docs/agents#workflows).
