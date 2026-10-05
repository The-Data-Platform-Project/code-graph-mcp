ContextForge is useful today, and it's deliberately narrow. This page lists what it doesn't do yet, so you can decide whether it fits before you spend time on it. Several of these are on the [roadmap](/roadmap).

## Access and onboarding

There's no self-service sign-up. The hosted deployment has one account, the owner, who signs in with a password. Google and GitHub sign-in are planned.

Nothing in the product connects to GitHub to pick repositories either. Self-hosted, you mount a directory, and hosted, the administrator loads the graphs.

MCP tokens are issued by the administrator. There's no page for minting your own.

## Indexing

Indexing only happens in the self-hosted stack. The hosted deployment serves graphs but can't index them.

Re-indexing is manual. There's no file watcher, no schedule and no re-index on push, so you run `reindex_repository` after changes.

Each repository is a single snapshot, indexed as it is on disk at that moment. There are no branches, commits or history yet.

Only the supported languages are parsed. Python and JavaScript/TypeScript get a full symbol and call graph. HTML/Jinja, CSS, JSON and YAML contribute dependencies, and other config files become searchable file nodes. Anything else isn't parsed.

Files over `MAX_FILE_BYTES` (1.5 MB by default) are skipped, and build and dependency folders are pruned.

## What the graph models

Only functions, classes, methods, interfaces, files, config files and Compose services become nodes. Variables, constants and directories don't.

Resolution is static and works per repository. Calls through dynamic dispatch, reflection or callbacks passed around as values, and calls into other repositories or libraries, are recorded as unresolved instead of guessed. A name that's defined more than once with no import to tell them apart also stays unresolved.

Documentation isn't linked to code. READMEs show up per repository, but the prose isn't connected to the symbols it talks about.

## Graph explorer

The explorer draws at most 3,000 nodes per repository.

It doesn't group by organization or by application area (frontend, backend, docs), there's no edge inspector, and there's no expand-on-click exploration. It loads a repository's graph and then filters it.

## MCP tools

`trace_call_path` stops at 500 nodes or 50 children per node, and reports `truncated: true` when it does.

Snippets can drift. `get_code_snippet` and the explorer cut source by the line numbers recorded at index time, so if a file changed after it was indexed, re-index before you trust the lines.

Claude Code is the only client it's been tested with. Other MCP clients that support streamable HTTP with a bearer token should work, but I haven't tried them.

## Platform

The self-hosted stack is single-user: one token and one owner login.

It was built and run with Docker inside WSL2 on Windows, and on Linux. It should work wherever Docker Compose does, but those two are what it was developed on.
