# 03 — Implementation Plan

Eight phases, each broken into PR-sized steps. Every step lists the files it touches, the
tests that gate it, and its exit criteria. **Rule for every phase:** the whole test
suite stays green (57 tests at the Phase 1 baseline, 88 after it), and the MCP
service keeps working unchanged.

Legend: 🆕 new file · ✏️ modified existing file

At the end of each phase the report covers: what was implemented · what changed · what
remains · assumptions · limitations · migration risks.

---

## Phase 1 — Assessment & foundations — **DONE**

Assessment: [00-current-state](00-current-state.md). Foundation steps as delivered:

| Step | Work | Files | Status |
|---|---|---|---|
| 1.1 | CI: ruff + pytest on push/PR (Python 3.11, pip cache) plus an image-build job. Lint rule set pinned in `pyproject.toml` (`E4,E7,E9,F,I,B,UP009,UP010`) so CI and local agree; five pre-existing violations fixed. `ruff format` deliberately *not* enforced — the codebase is not ruff-format formatted and reformatting it is out of scope. | 🆕 `.github/workflows/ci.yml`, ✏️ `pyproject.toml`, ✏️ `queries.py`, ✏️ `extractors/{python,javascript}.py`, ✏️ `scripts/call_tool.py` | ✅ lint clean |
| 1.2 | Corrected WSL path, added the lint command, pointed at `docs/architecture/` | ✏️ `CLAUDE.md` | ✅ |
| 1.3 | MCP contract goldens: a 13-file multi-language fixture repo, all nine tools plus five error paths snapshotted to JSON, volatile fields scrubbed, `UPDATE_GOLDEN=1` to regenerate | 🆕 `tests/test_mcp_contract.py`, 🆕 `tests/fixtures/mcp_contract/**`, 🆕 `tests/golden/*.json` (16) | ✅ 17 tests |
| 1.4 | Optional extras `[platform]`, `[api]`, `[dev]`; every pin verified resolvable. The MCP image still installs `requirements.lock.txt` only, so it is unchanged. Per-extra lock files come with Phase 2, when something actually installs them. | ✏️ `pyproject.toml` | ✅ |
| 1.5 | Ten fixture repositories across three orgs + metadata manifest + a builder that materializes them as git repos with scripted commit dates. Planted secrets and the oversized file are generated at build time, never committed. | 🆕 `tests/fixtures/orgs/**`, 🆕 `tests/platform/{conftest,fixture_repos,planted_secrets,test_fixtures}.py` | ✅ 14 tests |

**Exit:** met. 88 tests pass (57 baseline + 17 contract + 14 fixtures); lint clean.

Carried into Phase 2: per-extra lock files (1.4), and CI must be observed green on
the first push (it has not run yet — the workflow is committed but untriggered).

---

## Phase 2 — Stable graph & repository model

Goal: the ID-stable, snapshot-versioned graph end to end for *local and GitHub*
repositories with the existing extraction depth, stored in Supabase, served by a basic API.

| Step | Work | Files | Tests |
|---|---|---|---|
| 2.1 | Local Supabase: `supabase init`; migrations `0001`–`0003`, `0007`; seed registries | 🆕 `supabase/config.toml`, 🆕 `supabase/migrations/0001…0003,0007_*.sql`, 🆕 `supabase/seed.sql`, 🆕 `supabase/rollback/*.sql` | 🆕 `supabase/tests/0001_registries.sql` (pgTAP), migration up→down→up test |
| 2.2 | Settings & identity: pydantic settings (no secrets in code), UUIDv5 builders, normalization | 🆕 `platform/settings.py`, 🆕 `platform/identity.py` | 🆕 `tests/platform/test_identity.py`: determinism, rename stability, duplicate ordinals (property tests) |
| 2.3 | Source providers: `GitProvider` protocol; `LocalProvider` (paths under `/workspaces`, reuses `safe_join`); `GitHubProvider` (single repo, list, org, manifest; GitHub App/PAT; ETag; rate-limit backoff); include/exclude glob rules | 🆕 `platform/sources/{base,local,github,manifest}.py`, 🆕 `codegraph.example.yaml` | 🆕 `test_sources_local.py`, 🆕 `test_sources_github.py` (respx-mocked: pagination, 304, 403, rename keeps ID, duplicates collapse by ID) |
| 2.4 | Snapshot acquisition: treeless partial-clone mirror cache, checkout at SHA into a worktree, `changed_paths` via `git diff -M` | 🆕 `platform/snapshot/{git_mirror,workspace}.py` | 🆕 `test_git_mirror.py` against fixture repos: pin SHA, branch head, rename detection |
| 2.5 | Analysis adapter: run the existing `Indexer` into `/cache/staging/<repo_key>.db`; **injectable `WalkRules`** (keeps the default prune set, adds include/exclude and allows `.github`); refuse roots containing other tracked repos (the `telemetry-pipeline` problem) | ✏️ `indexer.py` (optional `walk_rules` param, default = today's behavior), 🆕 `platform/analysis/staging.py` | Existing tests + goldens unchanged; 🆕 `test_staging_adapter.py`; 🆕 `test_walk_rules.py` |
| 2.6 | Canonical model and builder: staging SQLite → `CNode/CEdge` with keys, type mapping (§1.2 of `02`), Directory nodes, `semantic_hash`/`row_hash`, provenance | 🆕 `platform/graph/{canonical,builder}.py` | 🆕 `test_builder.py`: node/edge identity, duplicate-edge prevention, idempotent rebuild (byte-identical output twice) |
| 2.7 | Validation v1: registry, uniqueness, dangling endpoints, self-edges, locations, contamination, count bounds | 🆕 `platform/graph/validate.py` | 🆕 `test_validate.py`: one failing case per rule |
| 2.8 | Store: `GraphStore` protocol; `MemoryStore` (tests) and `PostgresStore` (COPY + merge delta writer, close/open intervals, `activate_snapshot`/`rollback_snapshot` SQL functions) | 🆕 `platform/store/{base,memory,postgres}.py`, 🆕 `supabase/migrations/0008_graph_functions.sql` (activate/rollback/diff) | 🆕 `tests/db/test_upsert.py`, `test_snapshot_activation.py`, `test_rollback.py` (marked `db`, run against local Supabase) |
| 2.9 | Pipeline runner v1: `Stage` protocol, stage runs, repository run, run orchestration, queue claim/heartbeat/reaper, concurrency guard. Stages implemented: 1–4, 6–8 (existing depth), 14–17, 19 | 🆕 `platform/pipeline/{stage,runner,run,queue}.py`, 🆕 `platform/pipeline/stages/*.py` | 🆕 `test_runner.py`: per-repo isolation (one failing repo, others succeed), retry, idempotency (rerun = 0 writes), concurrent-claim protection, failed validation leaves the previous snapshot active |
| 2.10 | CLI: `codegraph sources list`, `ingest --repo/--org/--manifest [--force] [--sha]`, `worker`, `runs list/show` | 🆕 `platform/cli.py`, ✏️ `pyproject.toml` scripts | 🆕 `test_cli.py` (Typer runner) |
| 2.11 | API v1 (FastAPI): auth dependency (Supabase JWT), pagination envelope, error model; `GET /repositories`, `/repositories/:id`, `POST /repositories`, `POST /repositories/import`, `POST /repositories/:id/ingest`, `GET /graph/nodes`, `/graph/edges`, `/graph/neighborhood/:nodeId`, `/nodes/:id`, `/nodes/:id/relationships`, `/functions/:id/callers\|callees`, `/ingestion/runs[/:id]`, `POST /ingestion/run`, `/graph/snapshots[/active]` | 🆕 `api/{app,deps,schemas}.py`, 🆕 `api/routers/*.py`, 🆕 `supabase/migrations/0009_rls.sql` | 🆕 `tests/api/*`: schema validation, pagination, 401/403/404 shape, RLS (private repo invisible to non-member) |
| 2.12 | Containers: `worker` (git + platform extra), `api`; compose for local platform; egress allowlist documented | 🆕 `deploy/{worker,api}.Dockerfile`, 🆕 `deploy/compose.platform.yml`, 🆕 `.env.platform.example` | Smoke: ingest fixture org via compose → API returns nodes |

**Exit (Definition of Done items 1–3, 15, partly 4):** configure repos → versioned graph in
Supabase → API neighborhood query works; a failed validation cannot replace the active snapshot.

**Risks:** qualified-name collisions leading to key churn (measure the duplicate rate on
the 6 live repos in 2.6); COPY through Supabase pooler (use a session-mode connection);
the git binary in a read-only rootfs container (writable cache volume).

---

## Phase 3 — Static code intelligence

| Step | Work | Files | Tests |
|---|---|---|---|
| 3.1 | `Fact` side-channel: `FileResult.facts: list[Fact] = []`; staging `facts` table; redaction at buffer time | ✏️ `models.py`, ✏️ `indexer.py`, ✏️ `db.py` (additive table), 🆕 `platform/security/{redact,patterns}.py` | Goldens unchanged; 🆕 `test_redact.py` (token corpus, no false negatives on known formats) |
| 3.2 | Python extractor depth: docstrings, parameters/annotations, return type, decorators, async, `__all__` exports, body hash, cyclomatic complexity; route decorators (FastAPI/Flask/Django urls), Click/Typer/argparse commands, pytest tests; `os.environ`/`getenv` refs; URL literals | ✏️ `extractors/python.py` | ✏️ `tests/test_extractor.py` + 🆕 `test_python_facts.py` |
| 3.3 | JS/TS depth: JSDoc, params/types, exports, Express/Fastify/Next.js routes, `process.env`, `fetch`/axios URLs, Jest/Vitest/Mocha tests | ✏️ `extractors/javascript.py` | ✏️ `tests/test_js.py` + 🆕 `test_js_facts.py` |
| 3.4 | Markdown extractor (README, docs/, ADR `docs/adr/NNNN-*.md`, CHANGELOG): headings outline, links → DOC_REFERENCES (repo/file/function mentions in backticks), redacted body | 🆕 `extractors/markdown.py`, ✏️ `languages.py` (`.md`, `.mdx`) | 🆕 `test_markdown.py` |
| 3.5 | OpenAPI (JSON/YAML with an `openapi`/`swagger` key) → ApiSpecification + OpenApiEndpoint | 🆕 `extractors/openapi.py`, ✏️ `extractors/{json,yaml}.py` dispatch | 🆕 `test_openapi.py` |
| 3.6 | Builder: Function/Method details, ApiRoute, TestCase/TestSuite, TESTS edges (naming + import heuristics as `inferred`), DOCUMENTED_BY, EXPORTS, OVERRIDES (method name in a resolved base class) | ✏️ `platform/graph/builder.py`, 🆕 `supabase/migrations/0004_source_details.sql` | ✏️ `test_builder.py`; 🆕 `tests/db/test_details.py` |
| 3.7 | Function descriptions: `DescriptionProvider` chain (docstring → API doc → signature template); cache by body hash; `description_source` column | 🆕 `platform/describe/{base,docstring,cache}.py` | 🆕 `test_describe.py` (priority order, cache hit, generated flag) |
| 3.8 | API: `GET /functions/:id`, `/nodes/:id/source` (GitHub contents at SHA or local worktree, redacted), `/nodes/:id/documentation`, `/repositories/:id/readme`, `/repositories/:id/files` | ✏️ `api/routers/*` | 🆕 API tests incl. source-access denial for a private repo |

**Exit (DoD 9–11 backend):** function detail with description, parameters, callers,
callees, tests, and source preview available via the API.

---

## Phase 4 — Application & architectural classification

| Step | Work | Files | Tests |
|---|---|---|---|
| 4.1 | Migrations `0005_classification.sql`, `0006_user_metadata.sql`; `effective_classifications` view | 🆕 migrations | pgTAP: override precedence, rejected hides inferred |
| 4.2 | Technology/framework detection from catalog (manifests, lockfiles, imports, Dockerfile base images) | 🆕 `platform/detectors/technologies.py`, 🆕 `detectors/catalog/technologies.yaml` | 🆕 `test_technologies.py` (FastAPI+Postgres+Docker fixture) |
| 4.3 | Boundary detection: npm/pnpm/yarn workspaces, `pyproject` packages, compose services, Dockerfiles, k8s deployments → Package/Workspace/Service/MonorepoComponent + PART_OF/CONTAINS | 🆕 `platform/detectors/boundaries.py` | 🆕 `test_boundaries.py` (monorepo fixture) |
| 4.4 | Layer classifier: path conventions, framework evidence, node facts (routes → API; ORM models → persistence; tests → quality) → multi-label `layers[]` + IN_LAYER with evidence | 🆕 `platform/classify/layers.py`, 🆕 `detectors/catalog/layers.yaml` | 🆕 `test_layers.py` |
| 4.5 | Repository category & use case: topics, README keyword rules, manifests, explicit `codegraph.yaml` (`application:`, `use_cases:`, `category:`) | 🆕 `platform/classify/categories.py` | 🆕 `test_categories.py` (case-study fixture, explicit vs inferred vs low-confidence) |
| 4.6 | Lifecycle: active/recent/stale/archived/abandoned/new/failed/missing-docs/incomplete, from metadata and run state (thresholds in settings) | 🆕 `platform/classify/lifecycle.py` | 🆕 `test_lifecycle.py` (stale fixture repo with backdated commits) |
| 4.7 | Application grouping suggestions: explicit manifest → declared; shared compose/infra/DB/API contract/naming → `classification_suggestions` with fingerprints | 🆕 `platform/classify/applications.py` | 🆕 `test_applications.py`: cross-org app, rejected not re-suggested |
| 4.8 | Organization and ownership: org nodes, CODEOWNERS → Team/MAINTAINS, contributors (where permitted), ownership gaps | ✏️ `sources/github.py`, 🆕 `detectors/ownership.py` | 🆕 `test_ownership.py` |
| 4.9 | API: `GET /applications`, `/use-cases`, `/classifications`, `POST /classifications/confirm`, `POST /applications/assign`, `POST /repositories/:id/tags`, `GET /graph/groups`; audit-logged | ✏️ `api/routers/classifications.py` | 🆕 API tests; 🆕 **survival test**: user assignment → re-ingest → assignment intact |

**Exit (DoD 5–7, 17):** organizations, applications, products, use cases, and case
studies represented; many-to-many grouping; layers; overrides survive ingestion.

---

## Phase 5 — External connectivity

| Step | Work | Files | Tests |
|---|---|---|---|
| 5.1 | Integration catalog: ~150 initial signatures (packages per ecosystem, import prefixes, env-var patterns, URL hosts, compose images, Terraform resource prefixes) → canonical system, node type, provider, confidence per evidence kind | 🆕 `detectors/catalog/integrations.yaml`, 🆕 `platform/detectors/integrations.py` | 🆕 `test_integrations.py`: Stripe via package + env, Postgres via `DATABASE_URL` + compose image, S3 via boto3 + URL, SQS publish vs consume |
| 5.2 | Infra extractors: Dockerfile (FROM, EXPOSE, ENV names), GitHub Actions (jobs, uses, registry pushes, deploy steps), Kubernetes manifests (Deployment/Service/Ingress, images, namespaces), Helm `Chart.yaml`/values keys, Terraform HCL (grammar-less block scanner: `resource`, `module`, `provider`) | 🆕 `extractors/{dockerfile,gha,terraform}.py`, ✏️ `extractors/yaml.py` (k8s kinds), ✏️ `languages.py` | 🆕 per-extractor tests; fixture `infra/` directory |
| 5.3 | Connection semantics: CONNECTS_TO / PUBLISHES_TO / CONSUMES_FROM / USES / RUNS_ON / BUILDS / DEPLOYS / PUSHES_TO / BUILT_FROM with evidence; SecretReference nodes (names only) | ✏️ `platform/graph/builder.py` | ✏️ `test_builder.py`; validation: no secret values |
| 5.4 | Package dependency graph: purl ThirdPartyPackage nodes; internal package → Repository DEPENDS_ON when a package name matches another tracked repo's manifest | 🆕 `platform/detectors/packages.py` | 🆕 `test_packages.py` (cross-repo dependency across two fixture orgs) |
| 5.5 | API: external systems list/detail (consumers, evidence, confidence, last detected) | ✏️ `api/routers/graph.py`, 🆕 `api/routers/external.py` | API tests |

**Exit (DoD 8):** external systems are distinct nodes with evidence, confidence, and
consumers, and no values are exposed.

---

## Phase 6 — Interactive UI

Stack: Vite · React 18 · TypeScript · TanStack Query/Router/Virtual · Zustand · Sigma.js 3 +
graphology · ELK.js (worker) · ForceAtlas2 (worker) · react-markdown + rehype-sanitize ·
Shiki · Vitest + Testing Library · Playwright. API client generated from FastAPI's OpenAPI.

| Step | Work | Key files |
|---|---|---|
| 6.1 | Scaffold, design tokens (light/dark), generated API client, auth (Supabase GitHub OAuth), app shell with global search bar | 🆕 `web/` scaffold, `web/src/api/`, `web/src/app/` |
| 6.2 | API support: `GET /graph/overview`, `/graph/subgraph`, `POST /graph/count`, `/graph/search`, `/graph/layout`; `graph_subgraph`/`graph_search`/`graph_count` SQL; rollup refresh (stage 18) | ✏️ `api/routers/graph.py`, ✏️ `0008_graph_functions.sql` (new migration), 🆕 `platform/graph/rollups.py` |
| 6.3 | Overview dashboard: totals, ingestion status, graph health, new/failed repos, high-centrality services, most-connected apps | `web/src/routes/overview/` |
| 6.4 | Graph explorer core: Sigma renderer, node shape/icon programs from `node_types`, dashed edges for inferred, outlined external nodes, pan/zoom, select/multi-select, expand/collapse, focus mode, minimap, fit, reset, breadcrumbs, back/forward, URL state | `web/src/graph/{renderer,programs,state,history}.ts` |
| 6.5 | Layout engine: strategy interface; force (FA2 worker), hierarchical and layered (ELK), radial, org/app clusters, dependency flow, **region layout** (ELK partitions: docs top, UI left, API center, data right, infra bottom, external ring) with group boundaries and collapsible regions; layout persistence | `web/src/graph/layouts/*`, `web/src/graph/layout.worker.ts` |
| 6.6 | Views: Organization, Application, Repository (graph ↔ file tree toggle), Function neighborhood, External systems | `web/src/routes/{orgs,apps,repos,functions,external}/` |
| 6.7 | Detail panel per type: Repository (sanitized README, metadata, deps/dependents, integrations, tree, recent changes), File, Function (signature, description + generated badge, params, callers/callees, tests, routes, complexity, provenance, Shiki source), Application, External integration | `web/src/panels/*` |
| 6.8 | Filter drawer (all brief facets, confidence slider, live counts via `/graph/count`), grouping selector, hide/show node and edge types | `web/src/filters/*` |
| 6.9 | Global search: debounced, typed results with parent repo + description + "open in graph"; filters | `web/src/search/*` |
| 6.10 | Correction workflow UI: assign app, tags, confirm/reject suggestions, relationship verdicts, custom relationships, annotations, custom groupings | `web/src/panels/edit/*` |
| 6.11 | Accessibility: keyboard navigation of graph (focus ring, arrow to neighbors), ARIA labels, list alternative for every graph view; no color-only encoding | cross-cutting |
| 6.12 | Retire `visualizer/` (README note + redirect to `web`) | ✏️ `README.md`, `visualizer/index.html` |

**Tests:** Vitest component tests (search, filtering, selection, expansion, panels, README
sanitization with a malicious fixture `<script>`/`onerror`, layout switching, grouping,
empty/error states); Playwright E2E against the seeded fixture org; **performance test**:
synthetic seed of 20k nodes / 200k edges (`codegraph seed-synthetic`), assert overview
< 2 s TTI, neighborhood expand < 500 ms p95, ≥ 30 fps at 2,000 rendered nodes.

**Exit (DoD 9–12):** full exploration, README and function detail, search, filter,
grouping, drill-down.

---

## Phase 7 — Incremental daily pipeline & change intelligence

| Step | Work | Files | Tests |
|---|---|---|---|
| 7.1 | Commit-aware skip, analyzer-version invalidation, detector-only re-run from cached ASTs, stage artifact resume | ✏️ `pipeline/runner.py`, 🆕 `pipeline/artifacts.py` | 🆕 `test_incremental.py`: unchanged repo = 0 parses & 0 writes; one-file change = 1 parse; delete file closes rows; retry resumes at failed stage |
| 7.2 | Scheduler abstraction: `LocalScheduler` (APScheduler, cron + TZ) and pg_cron migration that inserts `ingestion_runs`; webhook receiver stub (`POST /webhooks/github`, signature verified, enqueues) | 🆕 `platform/scheduler/{base,local}.py`, 🆕 `supabase/migrations/0010_cron.sql`, 🆕 `api/routers/webhooks.py` | 🆕 `test_scheduler.py` (TZ/DST), webhook signature tests |
| 7.3 | Diff and change materialization: `graph_changes` per activation (added/removed/changed/moved/renamed), change summary; "since yesterday" aggregation across activations | 🆕 `platform/graph/diff.py`, ✏️ stage 18 | 🆕 `tests/db/test_diff.py` over scripted fixture history |
| 7.4 | Recalculate affected classifications, integrations, and rollups only for changed repos; removed/archived repo handling with retention | ✏️ classify/detectors, 🆕 `platform/pipeline/retention.py` | 🆕 `test_retention.py` |
| 7.5 | API + UI: `GET /graph/diff`, `/ingestion/health`; "What changed" view with navigate-to-region; graph diff mode styling (added/removed/changed glyphs, not color alone); pipeline monitoring UI (runs, stages, errors, validation reports, retry button) | ✏️ api, 🆕 `web/src/routes/{changes,pipeline}/` | Component + E2E tests |
| 7.6 | Observability: structlog JSON with correlation IDs, stage metrics, API latency middleware, UI perf beacons | 🆕 `platform/observability/*`, ✏️ `api/app.py` | Log-shape tests |

**Exit (DoD 13–16):** daily incremental updates, unchanged repos skipped, failures
isolated, changes reviewable over time.

---

## Phase 8 — Advanced intelligence

Starts only after the Phase 7 exit criteria have held for ≥ 1 week of daily runs.

| Step | Work |
|---|---|
| 8.1 | Embedding provider interface (local sentence-transformer default; remote opt-in), cached by source hash; `node_embeddings` + HNSW index |
| 8.2 | Repository similarity: weighted combination (README embedding, manifest Jaccard, language/framework vectors, directory-shape MinHash, symbol-name MinHash, topics) → SIMILAR_TO / POSSIBLY_DUPLICATES / shared-template suggestions (never auto-merge) |
| 8.3 | Centrality: in-degree/PageRank/betweenness on rollup graphs, computed in the worker with networkx on rollups only; single-point-of-failure flags; cross-org coupling scores |
| 8.4 | Blast radius / change impact: reverse transitive closure over CALLS/IMPORTS/DEPENDS_ON/CONNECTS_TO with depth and confidence decay; `GET /nodes/:id/impact` |
| 8.5 | Generated descriptions via LLM (local first; remote gated by `ALLOW_REMOTE_AI` + per-repo opt-in + private-repo deny), marked generated |
| 8.6 | Semantic search (pgvector) merged with FTS ranking |
| 8.7 | Timeline/change-oriented and data-flow layouts; risk findings (undocumented dependencies, orphaned repos, no maintainer) |

---

## Fixtures (`tests/fixtures/orgs/`) — built in Phase 1

Working trees plus `manifest.json` (GitHub-shaped metadata + the commit script).
`tests/platform/fixture_repos.py` materializes them into git repos with fixed authors
and scripted dates (`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`); the session-scoped
`fixture_orgs` fixture exposes them keyed by full name.

| Org | Repo | Purpose |
|---|---|---|
| `acme` | `shop-web` | React/TS frontend, `fetch('/api/…')`, env `VITE_API_URL`, Jest tests |
| `acme` | `shop-api` | FastAPI backend, routes, SQLAlchemy + Postgres, Stripe SDK, Redis cache, SQS publish, pytest, OpenAPI file, Dockerfile, k8s manifests, `codegraph.yaml` (`application: shop`, `use_cases: [e-commerce]`) |
| `acme` | `shop-infra` | Terraform (AWS RDS, S3, SQS), Helm chart, GH Actions pushing to GHCR |
| `acme` | `common-lib` | Shared Python package consumed by `shop-api` and `globex/analytics` |
| `globex` | `analytics` | ETL consuming SQS, writes to BigQuery; depends on `acme/common-lib` (cross-org) |
| `globex` | `case-study-retail` | README-driven case-study classification, docs/ADRs |
| `globex` | `old-prototype` | Stale (last commit 2 years back), no README, archived flag in mocked metadata |
| `globex` | `mono` | pnpm workspace monorepo with 2 apps + 1 package |
| `sandbox` | `secrets-trap` | Planted fake tokens (AWS, GitHub, Slack, Stripe, JWT, PEM, `.env` values) → must never persist. Assembled from fragments at build time so no literal token is committed. |
| `sandbox` | `broken` | Unparseable Python, unsupported language (`.zig`), and a 2 MB generated file over the index cap |

GitHub metadata for fixtures is served by a respx mock keyed by fake repository IDs,
including a renamed repo and a duplicate listing (same ID via org and manifest).

---

## Test matrix → brief §26

| Brief area | Where |
|---|---|
| Pipeline (discovery, identity, duplicates, incremental, deleted files, retry, idempotency, activation, failed validation, concurrency) | `tests/platform/test_{sources_*,identity,runner,incremental,snapshot_*}.py`, `tests/db/*` |
| Parsing (files, functions, symbols, imports, calls, routes, infra, integrations, unsupported) | existing `tests/test_*.py` + `tests/platform/test_{python_facts,js_facts,markdown,openapi,dockerfile,gha,terraform,integrations}.py` |
| Graph (identity, duplicates, consistency, multi-repo, cross-org, provenance, confidence) | `test_{builder,validate,packages,applications}.py` |
| Supabase (migrations, upserts, indexes, pagination, neighborhood, snapshot queries, access control) | `supabase/tests/*.sql` (pgTAP), `tests/db/*` (incl. `EXPLAIN` assertions that neighborhood uses `graph_edges_src/dst`) |
| UI (search, filters, selection, expansion, panels, README, function detail, layouts, grouping, diff, perf, empty/error) | `web/src/**/*.test.tsx`, `web/e2e/*.spec.ts`, `web/perf/*.spec.ts` |

---

## Operational commands (target)

```bash
supabase start && supabase db reset             # local DB with migrations + seed
codegraph ingest --manifest codegraph.yaml --full
codegraph ingest --repo acme/shop-api [--sha <sha>] [--force]
codegraph worker --concurrency 2                # claims queued repository runs
codegraph schedule --cron "0 2 * * *" --tz Europe/London   # local scheduler
codegraph runs show <run-id>
codegraph snapshots rollback --repo acme/shop-api --seq 42
codegraph export-user-metadata --out backup.json
uvicorn code_graph.api.app:app --port 8080
pnpm -C web dev
```

---

## Cross-phase migration and rollback policy

- Every migration is additive in the phase that introduces it. Destructive changes are
  split into expand → migrate → contract across two releases.
- Every `supabase/migrations/NNNN_*.sql` has a matching `supabase/rollback/NNNN_*.sql`,
  exercised in CI (up → down → up).
- The graph is re-derivable, so a botched graph migration is recoverable by
  `codegraph ingest --full --force`. **User tables are not re-derivable**: nightly
  export plus Supabase PITR.
- Changes to the analysis core must keep MCP goldens identical, or update them in the
  same PR with a justification.

## Decisions needed from the owner (defaults in `01` §12)

1. Approve the egress policy change for `worker` and `api` (MCP stays egress-free).
2. Hosted Supabase project (and region) for production.
3. GitHub App versus PAT, and which organizations to install on.
4. Whether any remote LLM use is ever permitted, and for which repositories.
5. History retention (default 30 snapshots per repo) and the removed-repo grace period.
