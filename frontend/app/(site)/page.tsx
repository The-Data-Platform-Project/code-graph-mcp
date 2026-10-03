import type { Metadata } from "next";
import Link from "next/link";
import DemoGraphView from "@/components/site/DemoGraphView";
import HeroVisual from "@/components/site/HeroVisual";
import { Icon } from "@/components/site/Icons";
import Screenshot from "@/components/site/Screenshot";
import { codeHtml } from "@/lib/markdown";
import { DEMO_REPO, HERO_FOCUS, demoGraph } from "@/lib/demo-graph";
import { APP_PATH, SITE } from "@/lib/site";
import CopyCode from "@/components/site/CopyCode";

export const metadata: Metadata = {
  title: { absolute: `${SITE.name}: ${SITE.tagline}` },
  description: SITE.description,
  alternates: { canonical: "/" },
  openGraph: { title: SITE.name, description: SITE.description, url: "/", siteName: SITE.name, type: "website" },
  twitter: { card: "summary_large_image", title: SITE.name, description: SITE.description },
};

const MCP_JSON = `{
  "mcpServers": {
    "code-graph": {
      "type": "http",
      "url": "\${CODE_GRAPH_MCP_URL:-http://127.0.0.1:8765/mcp}",
      "headers": { "Authorization": "Bearer \${CODE_GRAPH_TOKEN}" }
    }
  }
}`;

const TRACE = `trace_call_path(qualified_name="frontend.lib.viewer.getViewer",
                direction="callers", depth=2)

{ "root": "frontend.lib.viewer.getViewer", "nodes_visited": 2, "truncated": false,
  "tree": { "qualified_name": "frontend.lib.viewer.getViewer", "children": [
    { "qualified_name": "frontend.lib.viewer.requireViewer", "children": [
      { "qualified_name": "frontend.lib.handler.withViewer" } ] } ] } }`;

export default function Home() {
  const graph = demoGraph();
  const initial = Math.max(0, graph.nodes.findIndex((n) => n.id === HERO_FOCUS));

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <span className="eyebrow">Code intelligence for AI agents</span>
            <h1 className="display">
              Build context your <span className="grad-text">agents can use.</span>
            </h1>
            <p className="lede">
              ContextForge parses your repositories into a graph of files, functions and the
              calls and imports between them. You can explore that graph in the browser, and
              your AI agent can query it over MCP instead of reading file after file.
            </p>
            <div className="hero-ctas">
              <a className="btn btn-primary" href={APP_PATH}>Launch ContextForge</a>
              <Link className="btn btn-ghost" href="/docs/user-guide">Explore the User Guide</Link>
            </div>
            <div className="hero-meta">
              <a href={SITE.github} className="ext" rel="noopener noreferrer" target="_blank">View on GitHub</a>
              <span>Open source · Apache-2.0</span>
              <Link href="/docs/getting-started">Self-host with Docker</Link>
            </div>
          </div>
          <HeroVisual />
        </div>
      </section>

      {/* ── Problem ──────────────────────────────────────────────────────── */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="eyebrow">The context problem</span>
            <h2 className="h2">Your codebase is connected. Your AI&apos;s context should be too.</h2>
            <p className="lede">
              Software rarely makes sense one file at a time. A function calls other functions,
              a module imports others, and services talk to each other across the app.
            </p>
          </div>
          <div className="grid-3">
            <div className="card">
              <div className="icon"><Icon.split /></div>
              <h3 className="h3">Fragmented knowledge</h3>
              <p>What a function does depends on the files that call it, the modules it imports and the services around it, and those are all in different places.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.link /></div>
              <h3 className="h3">Hidden relationships</h3>
              <p>Understanding one change means tracing callers, callees and imports, and doing that by searching text is slow.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.search /></div>
              <h3 className="h3">Isolated snippets</h3>
              <p>Most of the context AI tools get today arrives as isolated snippets, without the structure that connects them.</p>
            </div>
          </div>
          <p className="statement" style={{ marginTop: 48 }}>
            So ContextForge writes those relationships down as a graph{" "}
            <em>you can browse and query.</em>
          </p>
        </div>
      </section>

      {/* ── Solution ─────────────────────────────────────────────────────── */}
      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="eyebrow">The context layer</span>
            <h2 className="h2">From source code to connected intelligence.</h2>
            <p className="lede">
              ContextForge parses the repositories you point it at and builds a graph of files,
              symbols and how they connect. You can explore it visually, and an AI agent can pull
              exactly the context it needs through MCP.
            </p>
            <p className="lede" style={{ color: "var(--text)" }}>
              The graph gives the agent the structure, and the agent does the reasoning.
            </p>
          </div>
          <div className="grid-4">
            <div className="card">
              <div className="icon"><Icon.layers /></div>
              <h3 className="h3">Understand the structure</h3>
              <p>Files, classes, functions, methods, interfaces, config files and Compose services, across Python, JavaScript and TypeScript, HTML and Jinja, CSS, JSON and YAML.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.link /></div>
              <h3 className="h3">Follow the connections</h3>
              <p>Calls, imports, inheritance, interface implementation and type usage, resolved across files and languages. Anything it can't resolve gets marked as unresolved instead of guessed.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.search /></div>
              <h3 className="h3">Query the context</h3>
              <p>Search symbols, list callers and callees, trace call paths several levels deep, list a file&apos;s imports, and fetch just the lines of one symbol.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.plug /></div>
              <h3 className="h3">Connect your agents</h3>
              <p>The graph is served over MCP with a bearer token. Add one block to Claude Code&apos;s MCP config and it&apos;s a tool call away.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Showcase ─────────────────────────────────────────────────────── */}
      <section className="section" id="showcase">
        <div className="container">
          <div className="section-head">
            <span className="eyebrow">Explore beyond the file tree</span>
            <h2 className="h2">See how your software fits together.</h2>
            <p className="lede">
              The graph explorer draws a repository as a graph you can search and filter. Open any
              symbol to read its source and see what calls it, what it calls and what its file
              imports, without losing sight of the rest of the codebase.
            </p>
          </div>

          <Screenshot
            src="/site/screens/explorer.png"
            alt="The ContextForge graph explorer: sidebar with repository selector, search and filters; the repository drawn as a force-directed graph; the README preview panel on the right."
            width={1600}
            height={1000}
            caption="The graph explorer, showing ContextForge's own repository."
          />

          <div className="split" style={{ marginTop: 72, alignItems: "start" }}>
            <div style={{ display: "grid", gap: 16 }}>
              <h3 className="h3" style={{ fontSize: 24 }}>Try it on a real graph</h3>
              <p className="muted" style={{ margin: 0 }}>
                Below is the core of ContextForge&apos;s own indexer, {graph.nodes.length} nodes and{" "}
                {graph.links.length} relationships exported from a real index of the{" "}
                <code>{DEMO_REPO}</code> repository. Hover a node to see what it&apos;s connected to,
                and click it (or any connection in the panel) to move through the code.
              </p>
              <Link className="link-arrow" href="/docs/explorer">Read the explorer guide</Link>
            </div>
            <ul className="feature-list">
              <li><span>Pick a repository and its README is a click away</span></li>
              <li><span>Search, and filter by node kind and relationship type</span></li>
              <li><span>Every node opens to Symbol, File and Connections tabs</span></li>
              <li><span>Unresolved and external references are marked, not hidden</span></li>
              <li><span>Source is read when you open it and never stored</span></li>
            </ul>
          </div>
          <div className="frame" style={{ marginTop: 32 }}>
            <DemoGraphView graph={graph} initial={initial} repo={DEMO_REPO} />
          </div>

          <div style={{ marginTop: 72 }}>
            <Screenshot
              src="/site/screens/connections.png"
              alt="A method opened in the explorer's preview panel, on the Connections tab: Called by, Calls with unresolved calls marked, the file's imports, Imported by, and other symbols in the file."
              width={1600}
              height={1000}
              caption="Every node opens to its source and connections; each entry navigates to that node."
            />
          </div>
        </div>
      </section>

      {/* ── Agents ───────────────────────────────────────────────────────── */}
      <section className="section">
        <div className="container split flip">
          <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
            <div className="code" dangerouslySetInnerHTML={{ __html: codeHtml(MCP_JSON, "json") }} />
            <div className="code" dangerouslySetInnerHTML={{ __html: codeHtml(TRACE, "text") }} />
          </div>
          <div style={{ display: "grid", gap: 20 }}>
            <span className="eyebrow">Built for agentic workflows</span>
            <h2 className="h2">Give agents context, not just code snippets.</h2>
            <p className="lede">
              ContextForge serves the graph over MCP, so an agent can search symbols, follow call
              chains, check what a file depends on and pull just the source it needs.
            </p>
            <ul className="feature-list">
              <li><span>Seven read tools: list_repositories, search_symbol, get_callers, get_callees, trace_call_path, get_dependencies and get_code_snippet</span></li>
              <li><span>Each token is shown once, stored only as a hash, and can be revoked</span></li>
              <li><span>Tested with Claude Code. Other streamable-HTTP MCP clients should work, but I haven&apos;t tried them yet</span></li>
            </ul>
            <p className="faint" style={{ margin: 0, fontSize: 14 }}>
              Left: the <code>.mcp.json</code> shipped in the repository, and a real call against
              ContextForge&apos;s own graph.
            </p>
            <Link className="link-arrow" href="/docs/agents">Explore agent integration</Link>
          </div>
        </div>
        <CopyCode />
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="section" id="how-it-works">
        <div className="container">
          <div className="section-head">
            <span className="eyebrow">How ContextForge works</span>
            <h2 className="h2">A clearer path from source to understanding.</h2>
          </div>
          <ol className="steps" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            <li className="step">
              <span className="num">01</span>
              <h3 className="h3">Point it at a repository</h3>
              <p>Run the Docker stack and mount the directory that holds your repositories, read-only.</p>
            </li>
            <li className="step">
              <span className="num">02</span>
              <h3 className="h3">Index its structure</h3>
              <p>One call, <code>index_repository</code>, parses supported files with tree-sitter and resolves references across them. <code>reindex_repository</code> later re-parses only what changed.</p>
            </li>
            <li className="step">
              <span className="num">03</span>
              <h3 className="h3">Explore the graph</h3>
              <p>Browse it in the explorer: filter by kind and relationship, open any symbol, follow its connections.</p>
            </li>
            <li className="step">
              <span className="num">04</span>
              <h3 className="h3">Connect an agent</h3>
              <p>Your agent queries the same graph through MCP tools instead of grepping and reading files.</p>
            </li>
          </ol>
          <div className="modes">
            <div className="mode">
              <span className="badge badge-available">Self-hosted · available</span>
              <h3 className="h3">Index and serve on your machine</h3>
              <p>Postgres, the indexer and MCP server, and the web app run in Docker Compose on <code>127.0.0.1</code>. Source previews read your disk.</p>
            </div>
            <div className="mode">
              <span className="badge badge-available">Hosted · available</span>
              <h3 className="h3">Serve a graph from the cloud</h3>
              <p>The web app on Vercel serves the explorer and <code>/api/mcp</code> from a Supabase database. It serves graphs indexed in a self-hosted stack; hosted indexing is <Link href="/roadmap" style={{ color: "var(--sky)" }}>planned</Link>.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Vision ───────────────────────────────────────────────────────── */}
      <section className="section">
        <div className="container">
          <div className="vision">
            <div className="vision-grid">
              <div style={{ display: "grid", gap: 18 }}>
                <span className="badge badge-vision" style={{ justifySelf: "start" }}>The vision · future direction</span>
                <h2 className="h2">From repository exploration to a living map of your software.</h2>
                <p className="lede">
                  Where we&apos;re taking ContextForge is a hosted platform: you sign in, connect
                  your repositories, and they get indexed and kept up to date for you.
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  The goal stays the same as today, making a codebase easier to understand and
                  giving AI agents structured context they can rely on, just across all your
                  repositories instead of the ones on one machine.
                </p>
                <Link className="link-arrow" href="/roadmap">See the roadmap</Link>
              </div>
              <ul aria-label="Planned capabilities">
                <li>Sign in with Google or GitHub, with owner approval</li>
                <li>Choose repositories through a GitHub App</li>
                <li>Cloud indexing with background jobs and status</li>
                <li>Re-indexing when repositories change</li>
                <li>Organization-level, multi-repository exploration</li>
                <li>Richer architectural grouping and more languages</li>
                <li>History across branches and commits</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section className="section-tight">
        <div className="container">
          <div className="cta-band">
            <h2 className="h2" style={{ maxWidth: 760 }}>
              Your code has a story. Give your agents the context to follow it.
            </h2>
            <p className="lede" style={{ textAlign: "center" }}>
              Index a repository, see how it fits together, and hand your agent the graph instead
              of a pile of files.
            </p>
            <div className="hero-ctas" style={{ justifyContent: "center" }}>
              <a className="btn btn-primary" href={APP_PATH}>Launch ContextForge</a>
              <Link className="btn btn-ghost" href="/docs/user-guide">Read the User Guide</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
