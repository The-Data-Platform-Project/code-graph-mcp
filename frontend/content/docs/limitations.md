ContextForge is useful today, and deliberately narrow. This page lists what it does **not** do yet, so you can decide whether it fits. Several items are on the [roadmap](/roadmap).

## Access and onboarding

- **No self-service sign-up.** The hosted deployment has one account, the owner, who signs in with a password. Google and GitHub sign-in are planned.
- **No repository connection flow.** Nothing in the product connects to GitHub to choose repositories. Self-hosted, you mount a directory; hosted, graphs are loaded by the administrator.
- **MCP tokens are issued by the administrator.** There is no page for minting your own.

## Indexing

- **Indexing is self-hosted only.** The hosted deployment serves graphs; it cannot index.
- **Re-indexing is manual.** There is no file watcher, no schedule and no re-index on push. Run `reindex_repository` after changes.
- **One snapshot per repository.** A repository is indexed as it is on disk at that moment. There are no branches, commits or history.
- **Supported languages only.** Python and JavaScript/TypeScript get a full symbol and call graph. HTML/Jinja, CSS, JSON and YAML contribute dependencies; other config files become searchable file nodes. Other languages are not parsed.
- **Large files are skipped** above `MAX_FILE_BYTES` (1.5 MB by default), and build and dependency folders are pruned.

## What the graph models

- **Only functions, classes, methods, interfaces, files, config files and Compose services are nodes.** Variables, constants and directories are not.
- **Resolution is static and per repository.** Calls through dynamic dispatch, reflection or callbacks passed as values, and calls into other repositories or libraries, are recorded as *unresolved* rather than guessed. An ambiguous name, one defined more than once with no import to disambiguate, also stays unresolved.
- **Documentation is not linked to code.** READMEs are shown per repository, but prose is not connected to the symbols it describes.

## Graph explorer

- At most **3,000 nodes per repository** are drawn.
- There is no grouping by organisation or by application area (frontend, backend, docs), no edge inspector, and no expand-on-click exploration. The explorer loads a repository's graph and filters it.

## MCP tools

- `trace_call_path` stops at **500 nodes** or **50 children per node** and reports `truncated: true` when it does.
- **Snippets can drift.** `get_code_snippet` and the explorer cut source by the line numbers recorded at index time. If a file changed after it was indexed, re-index before trusting the lines.
- Only **Claude Code** is tested as a client. Other MCP clients that support streamable HTTP with a bearer token should work.

## Platform

- The self-hosted stack is single-user: one token and one owner login.
- It was built and run with Docker inside WSL2 on Windows, and on Linux. Other setups should work wherever Docker Compose does, but are not what it was developed on.
