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
  title: { absolute: `${SITE.name} — ${SITE.tagline}` },
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
              Turn source code into connected, queryable knowledge. ContextForge maps the
              structure and relationships within your repositories, helping developers explore
              complex software and giving AI agents the context they need to navigate it.
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
            <p className="micro">From source code to structured context.</p>
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
              Software rarely makes sense one file at a time. Functions call other functions.
              Modules import dependencies. Services interact across application boundaries.
            </p>
          </div>
          <div className="grid-3">
            <div className="card">
              <div className="icon"><Icon.split /></div>
              <h3 className="h3">Fragmented knowledge</h3>
              <p>What a function means is spread across the files that call it, the modules it imports and the services around it.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.link /></div>
              <h3 className="h3">Hidden relationships</h3>
              <p>Understanding one change means tracing callers, callees and imports — work that is slow to do by searching text.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.search /></div>
              <h3 className="h3">Isolated snippets</h3>
              <p>Yet much of the context available to AI tools arrives as isolated snippets, without the structure that connects them.</p>
            </div>
          </div>
          <p className="statement" style={{ marginTop: 48 }}>
            ContextForge makes the relationships explicit, turning code structure into{" "}
            <em>knowledge that can be explored and queried.</em>
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
              ContextForge analyzes supported repositories and builds a structured graph of files,
              symbols, and their relationships. Developers can explore the graph visually. AI
              agents can retrieve targeted context through MCP.
            </p>
            <p className="lede" style={{ color: "var(--text)" }}>
              The graph provides the structure. The agent performs the reasoning.
            </p>
          </div>
          <div className="grid-4">
            <div className="card">
              <div className="icon"><Icon.layers /></div>
              <h3 className="h3">Understand the structure</h3>
              <p>Files, classes, functions, methods, interfaces, config files and Compose services — for Python, JavaScript and TypeScript, HTML and Jinja, CSS, JSON and YAML.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.link /></div>
              <h3 className="h3">Follow the connections</h3>
              <p>Calls, imports, inheritance, interface implementation and type usage, resolved across files and languages. What cannot be resolved is marked, never guessed.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.search /></div>
              <h3 className="h3">Query the context</h3>
              <p>Search symbols, list callers and callees, trace call paths several levels deep, list a file&apos;s imports, and fetch just the lines of one symbol.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.plug /></div>
              <h3 className="h3">Connect your agents</h3>
              <p>An MCP endpoint with bearer-token access. Add one block to Claude Code&apos;s MCP config and the graph is a tool call away.</p>
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
              symbol to read its source and follow what calls it, what it calls and what its file
              imports — without losing the bigger picture.
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
                Below is the core of ContextForge&apos;s own indexer — {graph.nodes.length} nodes and{" "}
                {graph.links.length} relationships exported from a real index of the{" "}
                <code>{DEMO_REPO}</code> repository. Hover a node to see its neighbourhood; click it,
                or any connection in the panel, to move through the code.
              </p>
              <Link className="link-arrow" href="/docs/explorer">Read the explorer guide</Link>
            </div>
            <ul className="feature-list">
              <li><span><b>Repository selector</b> with the README a click away</span></li>
              <li><span><b>Search and filters</b> by node kind and relationship type</span></li>
              <li><span><b>Symbol, File and Connections</b> tabs for every node</span></li>
              <li><span><b>Unresolved and external</b> references marked, not hidden</span></li>
              <li><span><b>Source read on demand</b> and syntax-highlighted — never stored</span></li>
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
              ContextForge exposes structured code intelligence through MCP, allowing compatible
              AI agents to search symbols, follow call relationships, inspect dependencies, and
              retrieve relevant source context.
            </p>
            <ul className="feature-list">
              <li><span><b>Seven read tools</b>: list_repositories, search_symbol, get_callers, get_callees, trace_call_path, get_dependencies, get_code_snippet</span></li>
              <li><span><b>Per-user tokens</b>, shown once, stored only as a hash, revocable</span></li>
              <li><span><b>Tested with Claude Code</b>; any streamable-HTTP MCP client should work</span></li>
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
              <p>The web app on Vercel serves the explorer and <code>/api/mcp</code> from a Supabase database. People sign in with GitHub and connect repositories with fine-grained tokens; a cloud indexer on AWS keeps them current, daily and on every push.</p>
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
                  ContextForge is evolving toward a hosted code intelligence platform where
                  repositories can be connected, indexed, and continuously refreshed.
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  The goal is to make software architecture easier to understand and give AI
                  agents reliable, structured context across applications, repositories, and
                  development workflows.
                </p>
                <Link className="link-arrow" href="/roadmap">See the roadmap</Link>
              </div>
              <ul aria-label="Planned capabilities">
                <li>Sign in with Google</li>
                <li>An admin portal with an audit log</li>
                <li>Self-service MCP tokens, quotas and rate limits</li>
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
              Build a connected view of your software and make its structure available to the
              tools that need it.
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
