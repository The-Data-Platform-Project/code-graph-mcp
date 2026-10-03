import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/site/Icons";
import Screenshot from "@/components/site/Screenshot";
import { APP_PATH } from "@/lib/site";

export const metadata: Metadata = {
  title: "Product",
  description:
    "What ContextForge does today: a tree-sitter indexer, a Postgres code graph, a visual explorer and an MCP endpoint for AI agents.",
  alternates: { canonical: "/product" },
};

const LANGS: [string, string][] = [
  ["Python", "Files, classes, functions, methods; imports, calls, inheritance, type use"],
  ["JavaScript · TypeScript", "Classes, functions (incl. nested and IIFE-wrapped), methods, interfaces; ES, require and dynamic imports; calls; extends and implements"],
  ["HTML · Jinja", "Script and stylesheet dependencies; template extends, include and import; macro definitions and uses"],
  ["CSS", "@import dependencies between stylesheets"],
  ["JSON · YAML", "package.json npm dependencies; Docker Compose services and depends_on"],
  ["Other config", "TOML, XML, INI, .env, Dockerfile, Makefile and dotfiles as searchable nodes"],
];

const TOOLS: [string, string][] = [
  ["list_repositories", "What is indexed, with counts and dates"],
  ["search_symbol", "Functions, methods, classes and interfaces by substring or glob"],
  ["get_callers", "Everything that calls a symbol"],
  ["get_callees", "What a symbol calls, resolved or not"],
  ["trace_call_path", "Call chains up or down, up to 20 levels"],
  ["get_dependencies", "A file's imports, in-project or external"],
  ["get_code_snippet", "Just one symbol's source, read on demand"],
  ["index_repository · reindex_repository", "Full and incremental indexing (self-hosted)"],
];

export default function ProductPage() {
  return (
    <>
      <header className="page-head">
        <div className="container">
          <span className="eyebrow">ContextForge today</span>
          <h1 className="display" style={{ fontSize: "clamp(36px, 5vw, 58px)" }}>
            A code graph for people and agents.
          </h1>
          <p className="lede">
            Everything on this page is available now. What comes next is on the{" "}
            <Link href="/roadmap" style={{ color: "var(--accent-2)" }}>roadmap</Link>.
          </p>
          <div className="hero-ctas">
            <a className="btn btn-primary" href={APP_PATH}>Launch ContextForge</a>
            <Link className="btn btn-ghost" href="/docs/getting-started">Get started</Link>
          </div>
        </div>
      </header>

      <section className="section">
        <div className="container split">
          <div style={{ display: "grid", gap: 18 }}>
            <span className="badge badge-available" style={{ justifySelf: "start" }}>Available</span>
            <h2 className="h2">An indexer that understands structure</h2>
            <p className="muted" style={{ margin: 0 }}>
              ContextForge parses each file with tree-sitter, extracts symbols and relationships,
              and resolves references across files and languages: an HTML page to the scripts it
              loads, a template to the one it extends, a service to the services it depends on.
              Resolution follows imports, then the enclosing class, then the same file, then a
              unique name — and anything still ambiguous is marked <em>unresolved</em> rather than
              guessed.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              Re-indexing is incremental: only files whose content changed are parsed again.
            </p>
          </div>
          <div className="prose">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Language</th><th>What becomes graph</th></tr></thead>
                <tbody>
                  {LANGS.map(([l, d]) => (
                    <tr key={l}><td><strong>{l}</strong></td><td>{d}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="badge badge-available">Available</span>
            <h2 className="h2">A visual explorer</h2>
            <p className="lede">
              Choose a repository, search, filter by node and edge type, and open any node to
              its source and connections.
            </p>
          </div>
          <Screenshot
            src="/site/screens/connections.png"
            alt="The explorer with a method selected: the Connections tab lists its callers, its callees with unresolved calls marked, the file's imports, the files that import it, and sibling symbols."
            width={1600}
            height={1000}
          />
        </div>
      </section>

      <section className="section">
        <div className="container split flip">
          <div className="prose">
            <div className="table-wrap">
              <table>
                <thead><tr><th>MCP tool</th><th>Answers</th></tr></thead>
                <tbody>
                  {TOOLS.map(([t, d]) => (
                    <tr key={t}><td><code>{t}</code></td><td>{d}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ display: "grid", gap: 18 }}>
            <span className="badge badge-available" style={{ justifySelf: "start" }}>Available</span>
            <h2 className="h2">An MCP endpoint for agents</h2>
            <p className="muted" style={{ margin: 0 }}>
              Coding agents query the graph over MCP (streamable HTTP, bearer token). Each
              question is one call with a short, structured answer — instead of a search followed
              by reading whole files. The hosted and self-hosted endpoints answer identically.
            </p>
            <Link className="link-arrow" href="/docs/api">MCP tool reference</Link>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <span className="badge badge-available">Available</span>
            <h2 className="h2">Built to be trusted with your code</h2>
          </div>
          <div className="grid-3">
            <div className="card">
              <div className="icon"><Icon.eye /></div>
              <h3 className="h3">Structure only</h3>
              <p>The database holds names, locations and relationships. Source text is read when you ask for it and never stored.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.shield /></div>
              <h3 className="h3">Isolated graphs</h3>
              <p>Each graph is its own database schema. A token reaches exactly one graph, is stored only as a hash, and can be revoked.</p>
            </div>
            <div className="card">
              <div className="icon"><Icon.cpu /></div>
              <h3 className="h3">Light and contained</h3>
              <p>One parse tree in memory at a time: 122 MiB peak indexing a 700+ file repository, in a read-only, unprivileged container that makes no outbound calls.</p>
            </div>
          </div>
          <p style={{ marginTop: 28 }}>
            <Link className="link-arrow" href="/docs/security">Security and data handling</Link>
          </p>
        </div>
      </section>

      <section className="section-tight">
        <div className="container">
          <div className="cta-band">
            <h2 className="h2">Run it on your own code.</h2>
            <p className="lede" style={{ textAlign: "center" }}>
              Open source under Apache-2.0. Docker Compose, one repository, about fifteen minutes.
            </p>
            <div className="hero-ctas" style={{ justifyContent: "center" }}>
              <Link className="btn btn-primary" href="/docs/getting-started">Get started</Link>
              <Link className="btn btn-ghost" href="/docs/limitations">Read the limitations</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
