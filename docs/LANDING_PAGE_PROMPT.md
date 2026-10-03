# Claude Code Prompt: ContextForge landing page and docs

Work on the `feature/landing-page` branch and deliver it as a pull request into
`main`. Pushing to `main` deploys production, so never push to it directly.

## Objective

Build a production-ready marketing and documentation site for **ContextForge**,
hosted on Vercel and built with **Watermelon UI**.

- Brand: ContextForge
- Domain: contextforge.ai
- Primary tagline: *Build context your agents can use.*
- Category: code intelligence and context infrastructure for AI agents.

The product already exists in this repository under its working name, **Code
Graph** (`code-graph-mcp`). Section 0 records what it actually does, checked
against the code on 2026-09-28. Treat section 0 as the source of truth. Where
the marketing copy below asks for something section 0 says doesn't exist, the
copy changes, not the facts. Still inspect the code yourself before you write
about it. If you find section 0 is wrong or out of date, fix this file in the
same PR.

Don't invent features, integrations, performance metrics or capabilities.

---

## Decisions (confirm or change before running)

| # | Decision | Default used by this prompt |
|---|---|---|
| D1 | **Who can use it today.** Sign-in works only for the owner, and there is no sign-up or waitlist. What does a visitor's main CTA do? | Primary **Launch app** goes to `/graph`, which redirects to `/login`. Secondary **Run it yourself** goes to `/docs/getting-started`. Add **View on GitHub**. No waitlist form, because none exists and building one is out of scope. |
| D2 | **Promote open source and self-hosting?** Both are true: the repo is public, Apache-2.0, and the Docker stack is the only way to index repos today. | Yes, stated plainly: "open source (Apache-2.0)", "self-host with Docker". |
| D3 | **Rename the app to ContextForge?** | Rename what users *see* (page titles, login page logo, metadata). Keep what clients *depend on*: the MCP server name `code-graph`, tool names, env vars, the `.mcp.json` key, script names. |
| D4 | **Hostnames.** | One domain. The site and the app are the same Next.js deployment: `contextforge.ai` for the site and docs, `contextforge.ai/graph` for the app. No `app.` subdomain. |
| D5 | **Demo data for screenshots and the interactive preview.** | The graph of **this repository** (public). Never show the owner's other indexed repositories: they may be private or client work. |

---

## 0. Verified product facts

### What it is

A code knowledge graph served over MCP. It parses repositories with
tree-sitter into a Postgres graph of files, symbols, imports and call chains.
Coding agents then ask structural questions (callers, callees, call paths,
dependencies, symbol search) with one tool call instead of a chain of grep and
file reads. **Only structure is stored, never source text.** Snippets and
previews are read fresh from disk, or from GitHub in the cloud, on each request.

### Two ways it runs today

| | Self-hosted (Docker Compose) | Hosted (Vercel + Supabase) |
|---|---|---|
| What runs | Postgres, the Python MCP server (port 8765), the Next.js app (3000), optional ngrok | the Next.js app only |
| Indexing | **Yes**: `index_repository` and `reindex_repository` over MCP | **No.** The graph is loaded by the admin from a local index (`scripts/load_sqlite_to_supabase.py`). |
| Repo source | any directory under the read-only `/workspaces` mount (`REPOS_HOST_PATH`) | none; previews read GitHub through `control.repo_connections` |
| MCP | `http://127.0.0.1:8765/mcp`, 9 tools, bearer `CODE_GRAPH_TOKEN` | `https://<host>/api/mcp`, 7 tools, bearer `cgk_…` token from `scripts/mcp_token.py` |
| Network | binds loopback only; the indexer makes **no outbound calls** | TLS to Supabase, verified against its CA |

Live today: `https://code-graph-viz.vercel.app`, owner-only, Vercel region `sin1`,
Supabase `ap-southeast-1`. `contextforge.ai` doesn't resolve yet (checked
2026-09-28).

### Indexing ("analysis")

- There are no analysis objects, jobs or processing states in the product.
  Indexing is a synchronous MCP tool call on the self-hosted server.
- `index_repository(name, path)` does a full index. `reindex_repository(name)`
  is **incremental by content hash**: it re-parses only changed files, drops
  deleted ones, and re-resolves.
- Each repo records `indexed_at` and node, edge and file counts
  (`list_repositories`).
- A missing grammar or an unparseable file is skipped; it never aborts the index.
- Memory, measured: about 45 MiB idle, **122 MiB peak** indexing a 700+ file,
  75k-edge repo, under a hard 500 MiB container cap, because only one parse
  tree is held at a time. This is the only measured performance number. Use it
  as stated or not at all.

### What it understands

- **Python** and **JavaScript/TypeScript** (JSX/TSX): full symbol and call
  graph, including nested functions and IIFE-wrapped modules.
- **HTML and Jinja templates:** `<script>`/`<link>` dependencies (including
  absolute `/static/…` paths), `{% extends/include/import/from %}`, and
  `{% macro %}` definitions and uses.
- **CSS** `@import`; **JSON** `package.json` npm dependencies; **YAML**
  docker-compose services and `depends_on`; any other config file as a
  searchable node.
- Cross-file references resolve across languages, through a cascade: import
  map → `self`/`this` → same module → unique name in the repo → left
  **honestly unresolved** rather than guessed.
- Node kinds: `File`, `Class`, `Function`, `Method`, `Interface`, `Config`,
  `Service`.
- Edge types: `CONTAINS`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`,
  `USES_TYPE`.
- Not modelled: directories as nodes, documentation-to-code links, branches or
  history (one snapshot per repo), other languages.

### The graph explorer (`frontend/components/Explorer.tsx`, `GraphCanvas.tsx`, `PreviewPanel.tsx`)

It has:
- A d3 force-directed graph, coloured by node kind, with counts of repos, nodes,
  edges and files.
- A **repository selector** ("All repositories" or one repo). Selecting a repo
  opens its README.
- **Symbol search:** debounced, narrows the graph.
- **Filters:** node-kind pills (7) and edge-type pills (6; `CONTAINS` off by
  default).
- **Preview panel** for a node, with tabs **Symbol** (just that symbol's
  source), **File** and **Connections**. Connections has Called by, Calls
  (unresolved callees marked), Imports of the file (external ones marked),
  Imported by, and Also in this file. Every entry navigates to that node.
- **README preview** (rendered markdown) and **source preview** (syntax
  highlighted, with line numbers).

It doesn't have: organisation grouping, automatic frontend/backend/docs
grouping, an edge inspector, or progressive expand-on-click. It loads a repo's
graph and filters it.

### Interfaces

- **MCP is the product's programmatic interface.** Streamable HTTP with a
  bearer token. Tools, the same on both backends with identical arguments and
  results (`scripts/mcp_parity.py` checks this):
  `list_repositories`, `search_symbol(pattern, repo?, limit?)`,
  `get_callers(qualified_name, repo?)`, `get_callees(qualified_name, repo?)`,
  `trace_call_path(qualified_name, direction, depth, repo?)`,
  `get_dependencies(file_path, repo?)`, `get_code_snippet(qualified_name, repo?)`.
  Self-hosted adds `index_repository(name, path)` and `reindex_repository(name)`.
  Read the exact descriptions and schemas from `frontend/lib/mcpServer.ts` and
  `src/code_graph/server.py`.
- **There is no public REST API.** `/api/graph`, `/api/node`, `/api/file` and
  `/api/readme` are the explorer's internal routes: session-cookie only,
  undocumented, free to change. Don't present or document them as an API.
  The "API Reference" page documents the MCP tools.
- Tested client: **Claude Code**. Other MCP clients that support streamable
  HTTP and a custom `Authorization` header should work; say "should", not
  "does".
- The real client config is `.mcp.json` in the repo root:
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

### Authentication and tenancy

- **Web:** a single owner password at `/login` (`OWNER_PASSWORD`), issuing a
  signed session cookie valid for 7 days. `middleware.ts` gates every page and
  graph API. Open paths: `/login`, `/api/auth/*`, `/api/health`, `/api/mcp`.
- **MCP:** 256-bit tokens, stored only as SHA-256 hashes, revocable, with
  last use recorded. The token alone selects the tenant. Tokens are minted by
  the admin with `scripts/mcp_token.py`; there is no self-service UI.
- **Tenancy:** each tenant's graph is its own Postgres schema (`tenant_<slug>`),
  and a schema name only ever comes from a token or session. Supabase's `anon`
  and `authenticated` roles can't reach any of it.
- The only auth seam is `getViewer()` in `frontend/lib/viewer.ts`. Don't add
  a second auth flow.

### Planned, not built (`docs/FUTURE_STATE.md`)

Google/GitHub sign-in via Supabase Auth; owner approval of new users; an admin
portal; a GitHub App to choose repos; an index job queue with a cloud worker;
re-indexing on push; later, all branches and commit history. On the site these
may appear only in a clearly labelled roadmap block ("Planned") or the FAQ,
never in feature cards, screenshots or the hero.

---

## 1. Brand positioning

ContextForge transforms source code into structured, connected context that
developers and AI agents can explore and query.

Traditional AI coding workflows often retrieve isolated files or snippets
without enough understanding of how the surrounding system fits together.

ContextForge maps the relationships across repositories, files, classes,
functions and methods, imports, calls, and inheritance, and the dependencies
between templates, stylesheets, packages and services.

The result is a navigable knowledge layer that helps developers understand
complex software and gives AI agents the architectural context they need,
through MCP.

Positioning:

> ContextForge is not another chatbot for your code. It is the context layer
> that makes code intelligence accessible to humans and AI agents.

Use this distinction throughout. It's true in a concrete way: ContextForge has
no model and no chat. It answers structured queries, and the agent does the
reasoning.

### Brand personality

- Modern developer infrastructure startup.
- Technically credible, concise, confident.
- Clear enough for an engineering manager, detailed enough for a platform
  engineer.
- Minimal jargon, no exaggerated AI marketing.
- Visual, architectural, product-led.
- Premium, polished, memorable.

Avoid "revolutionize your workflow", "unlock limitless potential", "supercharge
productivity", and any number of tokens or percentage saved: nothing has been
measured.

## 2. Design direction: Watermelon UI

**What Watermelon UI is:** the component registry at https://ui.watermelon.sh
(components, animated components, blocks, templates). Components are
shadcn-registry items installed with:

```bash
npx shadcn@latest add https://registry.watermelon.sh/r/<slug>.json
```

The code is copied into the repo, so there's no runtime CDN. This session has
the **Watermelon MCP tools** (`search`, `get_inspiration`, `get_component`,
`compose_page`). Use them to choose components and to get install commands and
dependencies. Don't substitute another library with a similar name. Some blocks
list no installable source; prefer entries with a `registryUrl`, and rebuild the
rest from Watermelon components rather than copying a preview.

**Integration constraint.** Watermelon needs Tailwind CSS and a shadcn setup
(`components.json`, a `cn` utility). `frontend/` has neither: the explorer is
hand-written CSS in `app/globals.css`, with DM Sans and JetBrains Mono via
`next/font`. Tailwind's preflight reset would restyle the explorer, so:

- Split the app into two route groups with **separate root layouts**:
  `app/(site)/…` for marketing and docs, with Tailwind and Watermelon; and
  `app/(app)/…` for the explorer and login, keeping `globals.css` exactly as it
  is.
- Keep the explorer pixel-identical. Check it before and after.

Visual identity (build on Watermelon's tokens):
- Dark charcoal or near-black surfaces.
- Watermelon/coral as the primary accent.
- Restrained mint or soft green for connections and status. This echoes the
  explorer's own palette (`KIND_COLORS` in `components/types.ts`).
- Crisp type, generous whitespace, subtle borders, controlled gradients and
  soft glows.
- Graph-inspired illustrations and relationship lines.
- Smooth, restrained interactions. Honour `prefers-reduced-motion`. Several
  blocks depend on `motion`/`framer-motion`; use them only where the motion
  earns its weight.

It should feel like a premium developer platform, not a generic AI template.
Prioritise desktop presentation, with fully responsive mobile layouts.

**Screenshots:** capture them from the real explorer, running the self-hosted
stack with **this repository** indexed (D5). Don't show fictional UI.

## 3. Site architecture

| Route | Page |
|---|---|
| `/` | Home |
| `/product` | Product |
| `/docs` | Documentation index |
| `/docs/getting-started` | Self-host with Docker, index a repo, connect Claude Code |
| `/docs/architecture` | How it works: indexer, graph, resolver, app, MCP; self-hosted vs hosted |
| `/docs/api` | **MCP tool reference** (there is no REST API; see section 0) |
| `/docs/agents` | Connecting an agent: `.mcp.json`, tokens, example sessions |
| `/faq` | FAQ |

Add these, which the implementation justifies:

| Route | Page |
|---|---|
| `/docs/graph-model` | node kinds, edge types, qualified names, the resolution cascade |
| `/docs/languages` | what each language contributes to the graph |
| `/docs/explorer` | using the graph explorer |
| `/docs/security` | trust boundary, tokens, tenancy, what is stored |
| `/docs/limitations` | what isn't modelled; hosted-mode limits |
| `/docs/troubleshooting` | the common failures and `tests/diagnostics/` |

**Move the explorer from `/` to `/graph`**, as planned in FUTURE_STATE.md §1.
That means:
- `middleware.ts`: make `/`, `/product`, `/docs/**`, `/faq`, `/sitemap.xml`,
  `/robots.txt` and the OG image public. Keep `/graph` and the graph APIs gated.
- `app/api/auth/login/route.ts`: the default post-login target becomes
  `/graph`, not `/`.
- `middleware.ts`: the redirect to `/login` must carry `next` for `/graph`.
- `tests/diagnostics/smoke_prod.sh` expects `/` → 307 `/login`. Change it to
  expect `/` → 200 and `/graph` → 307 `/login`, and add a check that `/docs`
  returns 200.

Include a header with working navigation, mobile navigation, a footer, SEO
metadata, `sitemap.xml`, `robots.txt` (disallow `/graph`, `/login`, `/api/`)
and Open Graph/Twitter metadata with a generated OG image.

## 4. Homepage copy and structure

### Navigation

Logo: ContextForge. Items: Product · How It Works (`/#how-it-works`) ·
Documentation (`/docs`) · Developers (`/docs/agents`) · **GitHub**
(https://github.com/The-Data-Platform-Project/code-graph-mcp; public, D2).

Primary CTA: **Launch App** → `/graph`. Secondary: **Explore Docs** → `/docs`.

### Hero

- Eyebrow: CODE INTELLIGENCE FOR AI AGENTS
- Headline: **Build context your agents can use.**
- Supporting copy: Turn repositories into connected, queryable knowledge.
  ContextForge maps the structure and relationships within your codebase,
  giving developers and AI agents the context they need to navigate complex
  software.
- Primary CTA: **Launch ContextForge** → `/graph`
- Secondary CTA: **See How It Works** → `/#how-it-works`
- Tertiary text link (D1/D2): **Open source · self-host with Docker** →
  `/docs/getting-started`
- Microcopy: From source code to structured context.

Allowed claims: open source (Apache-2.0); self-hostable; the indexer makes no
outbound network calls; source code is never stored. Not allowed: free (no
pricing exists), enterprise-ready, SOC 2 or compliance, any user count.

### Hero visual

Show, with the product's real terms:

**Repository → Parse (tree-sitter) → Code graph (Postgres) → MCP → AI agent**

Show files becoming connected nodes, then an agent calling one tool, for
example `get_callers("…")`, and getting back a short, structured answer instead
of reading whole files. Use a real query and its real result against this
repo's graph (D5).

The interactive preview must not call the authenticated APIs. Build a static
snapshot in the `{nodes, links, repos, stats}` shape that `/api/graph` returns
(`src/code_graph/graph_export.py`). Take it from one of two places:
- `/api/graph` on the local stack after indexing this repo, which is current; or
- `visualizer/export_graph.py`, which reads `data/graph.db`. That file's copy of
  this repo dates from 2026-09-13, and it **exports every repo in the file**,
  including the private ones.

Either way, **keep only nodes and links whose `repo` is this repository** (D5),
trim to a legible subgraph, and check the committed JSON contains no other repo
name. Render it with the same d3 approach as `GraphCanvas.tsx`. Keep it light:
lazy-load it and keep it off the critical path.

## 5. Problem section

- Eyebrow: THE CONTEXT PROBLEM
- Headline: Your codebase is connected. Your AI's context should be too.
- Body: Software rarely makes sense one file at a time. Functions call other
  functions. Modules import modules. Pages load scripts and stylesheets.
  Services depend on other services. Yet much of the context available to AI
  tools arrives as isolated snippets, and the relationships between them are
  hard to follow. ContextForge makes those connections explicit.

*(Changed from the original: "Documentation explains decisions that source
code alone cannot reveal" was dropped. The product doesn't link documentation
into the graph, so the problem it poses would go unsolved on the page.)*

Three cards:
- **Fragmented knowledge.** Important context is scattered across
  repositories, files and dependencies.
- **Hidden relationships.** Understanding one function often means tracing its
  callers, its callees and what its file imports.
- **Limited retrieval context.** A relevant snippet can say what a piece of
  code does without showing how it fits into the larger system.

## 6. Solution section

- Eyebrow: THE CONTEXT LAYER
- Headline: From files and folders to connected knowledge.
- Body: ContextForge parses your repositories and builds a graph of the
  entities and relationships that define your software. Explore it visually,
  query it through MCP, and give AI agents a clearer path from a question to
  the relevant code.

Four cards:
- **Understand the structure.** Repositories, files, classes, functions,
  methods, interfaces, config files and services, in one navigable view.
- **Follow the connections.** Calls, imports, inheritance, interface
  implementation and type usage, resolved across files and languages. What
  can't be resolved is shown as unresolved, not guessed.
- **Query the context.** Search symbols, list callers and callees, trace call
  paths several levels deep, list a file's dependencies, and fetch just the
  source of one symbol.
- **Connect your agents.** An MCP endpoint with per-user tokens. Add one block
  to your agent's MCP config.

Name **MCP** explicitly. Don't mention a REST API (section 0).

## 7. How it works (`id="how-it-works"`)

- Eyebrow: HOW CONTEXTFORGE WORKS
- Headline: A clearer path from source to understanding.

Four steps, true for today's self-hosted flow:
1. **Point it at your code.** Run the stack with Docker Compose and mount the
   directory that holds your repositories, read-only.
2. **Build the graph.** One MCP call, `index_repository`, parses every
   supported file with tree-sitter, extracts symbols and relationships, and
   resolves references across files. `reindex_repository` later re-parses only
   what changed.
3. **Explore the architecture.** Browse the graph, filter by kind and
   relationship, open any symbol to see its source, callers, callees and
   imports.
4. **Put context to work.** Your agent queries the same graph through MCP
   tools instead of grepping and reading files.

There are no processing states to show (section 0), so don't invent a
progress UI. A small "Planned" note may say that hosted indexing (connect
GitHub, index on push) is on the roadmap.

## 8. Interactive graph showcase

- Eyebrow: EXPLORE BEYOND THE FILE TREE
- Headline: See how the pieces fit together.
- Supporting copy: Move from a whole repository to the one function that
  matters. Filter by kind and relationship, open any symbol, and follow its
  callers, callees and imports without losing the bigger picture.

Show only what exists (section 0): the repository selector with README
preview, symbol search, kind and edge filters, the preview panel's Symbol,
File and Connections tabs, click-through navigation, unresolved and external
markers, and syntax-highlighted source. Leave out organisation grouping,
automatic area grouping, edge inspection and progressive expansion.

Make this one of the strongest sections. Use real screenshots of the explorer
on this repo, plus the snapshot preview from §4.

## 9. AI agent section

- Eyebrow: BUILT FOR AGENTIC WORKFLOWS
- Headline: Give agents context, not just code snippets.
- Body: A useful answer starts with the right context. ContextForge lets AI
  agents find code entities, follow their relationships and read just the
  source they need, through MCP tools. Instead of treating every question as a
  fresh search through disconnected files, agents query an indexed graph of
  the codebase.
- Diagram: **Repository → ContextForge graph → MCP (`/api/mcp`, bearer token)
  → AI agent (Claude Code tested; any streamable-HTTP MCP client)**
- Real, executable example: the `.mcp.json` block from section 0, then a short
  transcript of real tool calls against this repo's graph (`search_symbol`,
  `get_callers`, `trace_call_path`). Take the outputs from an actual run and
  trim them; don't fabricate them.
- CTA: **Explore Agent Integration** → `/docs/agents`

## 10. Developer experience

- Eyebrow: MADE FOR DEVELOPERS
- Headline: Built to explore. Designed to integrate.
- Body: Whether you're finding your way round an unfamiliar repository,
  tracing a dependency, or wiring an agent into your workflow, ContextForge
  gives you a structured starting point.

Highlights:
- **Visual exploration.** Navigate relationships without losing architectural
  context.
- **Targeted retrieval.** Ask for the callers of one function, not a folder of
  files.
- **Programmatic access.** Seven read tools over MCP, the same whether
  self-hosted or hosted.
- **Repeatable analysis.** Incremental re-indexing by content hash: re-parse
  only what changed (self-hosted).
- **Light by design:** peaked at 122 MiB indexing a 700+ file repo, one parse
  tree in memory at a time. This is a measured figure (section 0).

Code sample: a real MCP request/response, or the `.mcp.json` plus one tool
call. Never fabricate endpoints or response objects.

## 11. Use cases

- Eyebrow: WHERE CONTEXT BECOMES USEFUL
- Headline: Understand more. Search less.

Cards, each linked to a doc:
- **Repository onboarding** → `/docs/explorer`
- **Dependency investigation** (calls, imports, npm packages, compose
  services) → `/docs/graph-model`
- **Architecture discovery**, across repos and languages (HTML → JS/CSS,
  template → template) → `/docs/architecture`
- **AI-assisted development** → `/docs/agents`

## 12. Product philosophy

- Headline: The graph is the foundation. Context is the product.
- Body: ContextForge starts with the relationships already present in your
  software and makes them useful. The graph makes them visible. MCP makes them
  accessible. Together they give developers and AI agents a way to understand
  code in context.

Use one simple, memorable visual, not another card grid.

## 13. Final CTA and footer

- Headline: Your code has a story. Give your agents the context to follow it.
- Copy: Build a connected view of your software and make its structure
  available to the tools that need it.
- Primary: **Launch ContextForge** → `/graph`. Secondary: **Read the
  Documentation** → `/docs`.
- Footer tagline: ContextForge — Build context your agents can use.

Footer groups:
- **Product:** Product, How it works, Launch app.
- **Developers:** Getting started, Agent integration, MCP reference.
- **Documentation:** the docs pages.
- **Resources:** GitHub, FAQ.
- **Legal:** only the LICENSE (Apache-2.0, linked on GitHub). There's no
  privacy policy or terms page. Don't create placeholders; list them under
  "Remaining steps" in your summary.

## 14. Documentation

Write it from the code and the existing docs (`README.md`, `CLAUDE.md`,
`docs/ADMIN_GUIDE.md`, `docs/FUTURE_STATE.md`, `docs/SUPABASE.md`,
`tests/diagnostics/README.md`). Keep it practical, precise and task-oriented,
with no marketing language. The prompt's original topic list maps to reality
like this:

| Requested topic | Write it as |
|---|---|
| Supported repository sources | Self-hosted: any directory under the mounted `REPOS_HOST_PATH`. Hosted: graphs loaded by the admin; GitHub is used only for previews. GitHub App connection is planned. |
| Creating and managing an analysis | Indexing and re-indexing a repository (`index_repository`, `reindex_repository`, `list_repositories`) |
| Understanding analysis states | There are none. Say so in one line, and explain `indexed_at`, the counts, and that bad files are skipped. |
| Navigating the graph, searching and filtering, inspecting source context | `/docs/explorer`, with screenshots |
| Node and edge types | `/docs/graph-model`, including the resolution cascade and "unresolved" |
| Using the API | `/docs/api`: the MCP tools, each with arguments, an example call and a trimmed real result |
| Integrating with AI agents | `/docs/agents`: `.mcp.json`, `CODE_GRAPH_MCP_URL` and `CODE_GRAPH_TOKEN` (set in the client's own environment), local vs hosted, minting and revoking tokens |
| Authentication and authorization | `/docs/security`: owner login, session cookie, MCP tokens, tenant isolation, what is and isn't stored |
| Known limitations | `/docs/limitations`: section 0's "not modelled" list; hosted mode has no indexing; one snapshot per repo |
| Troubleshooting | `/docs/troubleshooting`: the ADMIN_GUIDE §6 table, plus the `tests/diagnostics/` scripts |
| Local development | `/docs/getting-started`: the Docker quick start from README.md |

Use real routes, commands and environment variable names; code blocks get
syntax highlighting and a copy button. Docs keep the real identifiers
(`code-graph`, `CODE_GRAPH_TOKEN`), and a short note on `/docs` says
ContextForge is the product name for the `code-graph-mcp` project.

Author the docs as MDX (or typed data) in the repo, rendered statically. Keep
docs navigation usable on mobile.

## 15. Technical implementation

- Same Next.js 15 / React 19 app in `frontend/`, App Router, TypeScript, with
  the route-group split from §2.
- Watermelon UI through the shadcn registry, with Tailwind added for the
  `(site)` group only.
- Marketing and docs pages are **static server components**. Client JavaScript
  only for the nav toggle, copy buttons and the lazy-loaded graph preview.
- Metadata: canonical URLs on `https://contextforge.ai` (from one
  `SITE_URL` constant or env var, defaulting to the Vercel URL until DNS
  exists), plus Open Graph, Twitter, `sitemap.xml` and `robots.txt`.
- Images through `next/image`; fonts through `next/font` (the app already
  self-hosts DM Sans and JetBrains Mono).
- Accessible contrast, focus styles and keyboard navigation; reduced motion.
- Don't touch the MCP route, `lib/mcpServer.ts`, the tenancy code or anything
  under `src/`.

## 16. Vercel deployment

- Vercel project: `code-graph-viz` (team *Ismail's projects*), Root Directory
  `frontend`, Next.js, functions pinned to `sin1` by `frontend/vercel.json`.
  **Production deploys `main`**; this branch gets preview deploys.
- Preview deploys have no database secrets, so `/graph` fails there by
  design. The site and docs must build and render **without any database env
  var**. Don't import `lib/pool.ts` or `lib/env.ts` from site pages.
- `contextforge.ai` isn't configured. Don't claim it's live. In the summary,
  give the steps: add the domain to the Vercel project, create the DNS records
  Vercel shows, then set `SITE_URL`.
- No new environment variables should be required. If you add `SITE_URL`,
  document it.

## 17. Workflow

1. Read section 0, then confirm it against the code; note any drift.
2. Look up Watermelon components with its MCP tools; set up Tailwind and
   shadcn for `(site)` only.
3. Write a short plan: page tree, components chosen, the route move.
4. Move the explorer to `/graph` and update middleware, the login redirect
   and `smoke_prod.sh`. Check the explorer is unchanged.
5. Build the shared layout, header, footer and section components.
6. Build Home, Product, FAQ, then the docs.
7. Capture screenshots and export the demo graph snapshot from this repo.
8. SEO, accessibility and responsive passes.
9. Verify (below).
10. Open the PR into `main`.

## 18. Definition of done

- A polished, responsive ContextForge site and docs, using Watermelon UI
  consistently.
- Every product claim traces to section 0 or to code. Planned items appear
  only as "Planned".
- All navigation and CTAs resolve: no 404s, no links to pages that don't exist.
- The explorer works at `/graph`, visually unchanged; login lands there; MCP
  unaffected.
- Verification passes, with the output reported:
  - `npm run build` and `npx tsc --noEmit` in `frontend/`;
  - `next lint`, or ESLint if you replace it: `next lint` is deprecated in
    Next 15.5;
  - `tests/diagnostics/run_tests.sh`: the Python suite, which should be
    untouched;
  - a local check that every sitemap URL returns 200 and `/graph` redirects;
  - after the preview deploy: `tests/diagnostics/smoke_prod.sh <preview-url>`
    with the updated checks. The database check will fail on preview without
    secrets; say so rather than hiding it.
- A PR into `main`, with a summary of pages, reused features, files changed,
  verification results, and the remaining steps: DNS for contextforge.ai,
  `SITE_URL`, legal pages, and switching sign-in when Supabase Auth lands.
