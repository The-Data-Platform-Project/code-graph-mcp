# 00 — Current-State Assessment (Phase 1)

Assessed on branch `feature/pipeline-overhaul` at `aa4db27`. This document records
what exists today, what can be reused, and the gaps between it and the
repository-intelligence platform described in the product brief.

## 1. Baseline

| Check | Result |
|---|---|
| Test suite (`~/cgvenv/bin/pytest`, WSL) | **57 passed, 0 failed** |
| Code size | ~6.3k lines tracked (Python ≈ 3.3k, visualizer 776, tests ≈ 0.9k) |
| Live graph (`data/graph.db`) | 6 repos · **16,030 nodes** · **108,254 edges** |
| Node mix | File 4,310 · Function 4,315 · Method 4,237 · Config 1,498 · Class 783 · Interface 732 · Service 54 |
| Resolution | CALLS 9,112 resolved / 15,250 unresolved (**~37 %**); IMPORTS 82 % flagged in-project |

The current data volume is already close to the 20k-node target, which makes it a
useful, realistic benchmark for the new platform.

## 2. What exists

### 2.1 Components

| Area | Today | Files |
|---|---|---|
| Frontend | Single static page: d3 force layout on `<canvas>`, loads a pre-exported `graph-data.json` (max 3,000 nodes per repo), kind/edge filters, detail box | `visualizer/index.html`, `visualizer/export_graph.py` |
| Backend | FastMCP server with 9 tools over streamable HTTP (loopback) | `src/code_graph/server.py` |
| Database | SQLite (WAL), 5 tables: `repos`, `nodes`, `edges`, `files`, `imports`. No migrations; `CREATE IF NOT EXISTS` at connect | `src/code_graph/db.py` |
| Graph model | 7 node kinds, 6 edge types; nodes keyed by autoincrement id, edges join on `(repo, qualified_name)` strings | `src/code_graph/models.py` |
| Ingestion | `os.walk` → per-file tree-sitter parse → extractor → batched insert; full index or content-hash incremental `reindex` | `src/code_graph/indexer.py` |
| Parsers | tree-sitter: Python, JS/TS/TSX, HTML (+regex Jinja), CSS, YAML (compose); grammar-less JSON (`package.json`) and generic config | `src/code_graph/extractors/*`, `languages.py` |
| Resolution | Post-index SQL cascade: import map → self/cls/this → same module → unique-in-repo → unresolved; trailing-path match for rooted assets/templates | `src/code_graph/resolver.py`, `naming.py` |
| Queries | callers, callees, BFS call path, dependencies, symbol search, snippet read from disk | `src/code_graph/queries.py` |
| Config | Env-driven frozen dataclass | `src/code_graph/config.py` |
| Deployment | One container, 500 MiB cap, read-only rootfs, `/workspaces` read-only bind of `F:`, no egress | `Dockerfile`, `docker-compose.yml` |
| Tests | Extractors, JS, Jinja, web, queries, reindex, config, util, memory (stdlib index < 450 MB RSS) | `tests/` |

### 2.2 How the graph is built

The graph comes from **static AST analysis** (tree-sitter) plus **heuristic,
path-based cross-file resolution**. No language servers, no embeddings, and no
manually defined relationships. Every edge is deterministic, and ambiguous targets
are left unresolved on purpose.

### 2.3 APIs and UI components

- **APIs:** only the 9 MCP tools. No REST/GraphQL API.
- **UI:** one HTML file with no build step and no components. It reads a static
  JSON export, not a live API, although a fallback `fetch('/api/graph')` is present
  and unused.

## 3. Reuse map

| Existing asset | Verdict | How it is reused |
|---|---|---|
| `extractors/*`, `languages.py`, `naming.py` | **Reuse as-is, then extend** | Becomes the static-analysis core behind a new `Analyzer` adapter. Extend `FileResult` with a `facts` side-channel (docstrings, decorators, routes, URL literals, env-var refs) that defaults to empty, so existing extractors and tests are unaffected. |
| `indexer.py` (walk, per-file memory discipline, hash-incremental reindex) | **Reuse via adapter** | The pipeline runs the existing `Indexer` against a **per-repository staging SQLite** in the worker cache. `reindex` already provides file-hash incrementality. Walk rules become injectable (include/exclude and allowing `.github/`). |
| `resolver.py` | **Reuse as-is** | Runs on the staging DB exactly as today. |
| `queries.py` + `server.py` (MCP) | **Preserve unchanged** | MCP remains a local, egress-free product. It can later gain a read-only Supabase adapter, but that is not required. |
| `db.py` schema | **Keep for MCP and staging** | It is not the platform store. Supabase/Postgres is the system of record for the platform graph. |
| `visualizer/` | **Keep until Phase 6, then deprecate** | Replaced by `web/`. Its kind colours and filters inform the new visual language. |
| Docker hardening pattern | **Reuse** | Applied to the new `worker` and `api` images. |
| `tests/` | **Keep green** | They are the regression gate for the analysis core in every phase. |

## 4. Gaps against the brief

### 4.1 Identity and lifecycle
- Repos are keyed by a **user-typed name**. There is no GitHub ID, organization, or metadata.
- Node IDs are **autoincrement integers** rebuilt on every full index, so they are not stable.
- Edges reference nodes by `(repo, qualified_name)` string. Qnames are **not unique**:
  there is no uniqueness constraint, and duplicate JS/TS names occur.
- There are **no snapshots**. `index_full` deletes and rebuilds in place, so readers can see a
  half-built repo, and history, diffs, and rollback are impossible.
- No provenance, confidence, origin (extracted, inferred, or user), or timestamps on
  nodes and edges.

### 4.2 Ingestion
- Local filesystem only: no GitHub discovery, clone, branch/SHA pinning, or private-repo auth.
- No stage model, run records, retries, stage metrics, or concurrency guard.
- No scheduler.
- **Inclusion rules are missing, and the data shows it.** Repo `telemetry-pipeline` was
  indexed with path `.` (the entire `F:` drive, 5,364 files, 14k nodes), mixing many
  repositories into one. The new pipeline must reject this through repository
  boundaries and a cross-repo contamination validation check.
- Dot-directories are pruned wholesale, so **`.github/workflows` is never seen**.

### 4.3 Analysis coverage
- No docstrings, parameters, return types, decorators, complexity, exports, or body hashes.
- No API routes, event handlers, CLI commands, tests-as-entities, env-var refs, URL literals, or SQL.
- No Markdown/docs, OpenAPI, Terraform, Kubernetes, Helm, Dockerfile (content), or GitHub Actions extraction.
- No framework or technology detection, and no external-integration detection.
- No application, service-boundary, layer, or business classification.

### 4.4 Storage and query
- SQLite single-writer, local only. No full-text search, vector search, RLS, pagination,
  or multi-hop SQL (BFS is done in Python with per-hop queries).

### 4.5 UI
- Static export capped at 3,000 nodes per repo. No server-side filtering, neighborhood
  loading, aggregation, multiple layouts, README or source preview, search, diff, or
  pipeline monitoring.

### 4.6 Security posture change (needs sign-off)
Today's guarantee is **no egress**. The platform must call GitHub and Supabase, and
optionally an LLM. The plan keeps the MCP container egress-free and isolates egress to
a new `worker` container with an explicit allowlist (`api.github.com`, `github.com`,
the Supabase host, and any opted-in LLM endpoint). See `01-target-architecture.md` §9.

### 4.7 Housekeeping found during assessment
- `CLAUDE.md` gives the WSL path as `/mnt/f/Code Graph/code-graph-mcp`. The actual path is
  `/mnt/f/The Data Platform Project/Code Graph/code-graph-mcp`.
- There is no CI workflow. Tests and ruff run only locally.

## 5. Migration strategy (summary)

1. **Strangler pattern.** Add the platform as new subpackages and new deployables beside
   the working MCP service. Nothing existing is removed until its replacement ships.
2. **The analysis core stays the source of truth for parsing.** The pipeline wraps it and
   does not fork it.
3. **Staging SQLite, then canonical graph, then Postgres.** The local SQLite remains the
   fast incremental analysis cache. A graph builder translates it into the canonical,
   ID-stable model, and only deltas are written to Supabase.
4. **Optional dependency extras** (`.[platform]`, `.[api]`) keep the MCP image small
   and egress-free.
5. The existing test suite is a required gate in CI from Phase 1 onward.
