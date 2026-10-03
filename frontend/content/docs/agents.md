ContextForge serves its graph over **MCP** (Model Context Protocol), so a coding agent can ask structural questions directly: who calls this, what does it call, what does this file import. Each answer is one tool call returning a short, structured result, instead of a search followed by reading whole files.

The examples on this page are real tool calls against the ContextForge repository, trimmed for length.

## Endpoints

| Deployment | URL | Token | Tools |
|---|---|---|---|
| Self-hosted | `http://127.0.0.1:8765/mcp` | `CODE_GRAPH_TOKEN` from your `.env` | 9: the seven read tools plus `index_repository` and `reindex_repository` |
| Hosted | `https://<your-deployment>/api/mcp` | A personal token beginning `cgk_`, issued by the administrator | 7 read tools |

Both use the **streamable HTTP** transport with an `Authorization: Bearer <token>` header. The read tools behave identically on both, with the same names, arguments and result shapes.

## Connect Claude Code

The repository ships a project-level `.mcp.json`:

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

Claude Code fills in `${…}` from **its own environment**, not from `.env`, so both values are set where Claude Code runs:

| Target | `CODE_GRAPH_MCP_URL` | `CODE_GRAPH_TOKEN` |
|---|---|---|
| Self-hosted | leave unset (defaults to `http://127.0.0.1:8765/mcp`) | the value of `CODE_GRAPH_TOKEN` in `.env` |
| Hosted | `https://<your-deployment>/api/mcp` | your `cgk_…` token |

```bash
export CODE_GRAPH_MCP_URL="https://<your-deployment>/api/mcp"
export CODE_GRAPH_TOKEN="cgk_..."
```

On Windows, with Claude Code running on the Windows side, use `setx` instead of `export`. Restart Claude Code, then run `/mcp`: `code-graph` should be listed with its tools. To use it from any directory, add the same block to your user-level Claude Code configuration.

Because both targets use the same two variables, Claude Code talks to one graph at a time. Switching is an environment change and a restart.

### Other MCP clients

Any client that supports streamable HTTP and a custom `Authorization` header should work with the same URL and token. Claude Code is the client ContextForge is tested with.

## Workflows

### Find a symbol

You rarely know a qualified name up front. `search_symbol` takes a substring or a glob.

```text
search_symbol(pattern="*resolve*", repo="code-graph-mcp", limit=12)
```

```json
{ "result": [
  { "kind": "Class", "name": "_Resolver", "qualified_name": "src.code_graph.resolver._Resolver",
    "file_path": "src/code_graph/resolver.py", "start_line": 189, "signature": "class _Resolver" },
  { "kind": "Function", "name": "_resolve_rooted_assets", "qualified_name": "src.code_graph.resolver._resolve_rooted_assets",
    "file_path": "src/code_graph/resolver.py", "start_line": 111,
    "signature": "def _resolve_rooted_assets(con: psycopg.Connection, repo: str) -> None" },
  …
] }
```

### Who calls this?

Before changing a function, find everything that depends on it.

```text
get_callers(qualified_name="src.code_graph.naming.file_qname", repo="code-graph-mcp")
```

It returns 12 callers, one per extractor that names files: `CssExtractor.extract`, `HtmlExtractor.extract`, `JavaScriptExtractor.extract`, `JsonExtractor.extract`, `YamlExtractor.extract`, `scan_jinja`, `PythonExtractor.module_qname` and more. Each comes with its file, line and signature.

### What does this do?

`get_callees` gives a function's outline without reading its body:

```text
get_callees(qualified_name="src.code_graph.indexer.Indexer.index_full", repo="code-graph-mcp")
```

```json
{ "result": [
  { "callee": "src.code_graph.db.connect", "resolved": true, "kind": "Function", "file_path": "src/code_graph/db.py", "start_line": 97 },
  { "callee": "src.code_graph.indexer.Indexer._ingest", "resolved": true, "kind": "Method", "file_path": "src/code_graph/indexer.py", "start_line": 147 },
  { "callee": "src.code_graph.indexer._clear_repo", "resolved": true, "kind": "Function", "file_path": "src/code_graph/indexer.py", "start_line": 297 },
  { "callee": "src.code_graph.indexer._finalize", "resolved": true, "kind": "Function", "file_path": "src/code_graph/indexer.py", "start_line": 314 },
  { "callee": "src.code_graph.resolver.resolve_repo", "resolved": true, "kind": "Function", "file_path": "src/code_graph/resolver.py", "start_line": 57 },
  { "callee": "con.close", "resolved": false, "kind": null, "file_path": null, "start_line": null },
  …
] }
```

The whole indexing pipeline in one answer: connect, clear, ingest, finalize, resolve. `con.close` is marked `resolved: false` because it is a library method, not a node in the graph.

### How is this reached?

`trace_call_path` walks the call graph several levels in either direction:

```text
trace_call_path(qualified_name="frontend.lib.viewer.getViewer", direction="callers", depth=2, repo="code-graph-mcp")
```

```json
{ "root": "frontend.lib.viewer.getViewer", "direction": "callers", "depth": 2, "nodes_visited": 2, "truncated": false,
  "tree": { "qualified_name": "frontend.lib.viewer.getViewer", "children": [
    { "qualified_name": "frontend.lib.viewer.requireViewer", "children": [
      { "qualified_name": "frontend.lib.handler.withViewer" } ] } ] } }
```

### What does this file depend on?

```text
get_dependencies(file_path="src/code_graph/resolver.py", repo="code-graph-mcp")
```

```json
{ "result": [
  { "local_name": "psycopg", "target": "psycopg", "kind": "module", "in_project": false },
  { "local_name": "db", "target": "src.code_graph.db", "kind": "symbol", "in_project": true },
  { "local_name": "Optional", "target": "typing.Optional", "kind": "symbol", "in_project": false },
  …
] }
```

`in_project` is true when the target is a node in the graph. Imported constants, such as `EDGE_CALLS` from `models.py`, show as `false`: constants are not nodes.

### Read just the code you need

Once the graph has pointed at the right symbol, fetch only its lines:

```text
get_code_snippet(qualified_name="src.code_graph.resolver._escape_like", repo="code-graph-mcp")
```

```json
{ "found": true, "kind": "Function", "file_path": "src/code_graph/resolver.py", "start_line": 107, "end_line": 108,
  "signature": "def _escape_like(s: str) -> str",
  "code": "def _escape_like(s: str) -> str:\n    return s.replace(\"\\\\\", \"\\\\\\\\\").replace(\"%\", \"\\\\%\").replace(\"_\", \"\\\\_\")" }
```

The code is read from the source when you ask for it, never from the database.

## Tips

- **Start with the graph.** Tell your agent, for example in the project's `CLAUDE.md`, to use the `code-graph` tools for "where is", "what calls" and "what depends on" questions before searching files.
- **Scope with `repo`** whenever more than one repository is indexed. The same qualified name can exist in several.
- **Re-index after changes** when self-hosted (`reindex_repository`). Answers reflect the last index, not your working tree.
- **Unresolved is not an error.** It means the call leaves the repository, or its target is ambiguous.

## Access and tokens

- Self-hosted: the MCP server accepts only requests carrying `CODE_GRAPH_TOKEN`, and binds to `127.0.0.1`.
- Hosted: each token is a random 256-bit value, shown once when it is created and stored only as a SHA-256 hash. A token reaches exactly one graph, the one it was issued for; no tool argument can select another. The administrator can revoke it at any time.

See [security and data handling](/docs/security) for the full model, and the [tool reference](/docs/api) for every argument.
