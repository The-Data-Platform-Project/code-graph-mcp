import type { Metadata } from "next";
import Link from "next/link";
import DocsShell from "@/components/site/DocsShell";
import { DOCS_NAV, docBySlug, pagerFor } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "How to run ContextForge, index repositories, explore the graph, and connect AI agents over MCP.",
  alternates: { canonical: "/docs" },
};

const PATHS: { title: string; body: string; href: string }[] = [
  {
    title: "Run it and index a repository",
    body: "Start the Docker stack, index a repository with one MCP call, and open the explorer.",
    href: "/docs/getting-started",
  },
  {
    title: "Learn the whole product",
    body: "The user guide covers every current capability in one place, with links to the detail.",
    href: "/docs/user-guide",
  },
  {
    title: "Connect an agent",
    body: "Add ContextForge to Claude Code's MCP config and query the graph from your editor.",
    href: "/docs/agents",
  },
  {
    title: "Look up a tool",
    body: "Arguments, results and real examples for every MCP tool.",
    href: "/docs/api",
  },
];

export default function DocsIndex() {
  const refs = ["architecture", "security", "limitations", "troubleshooting"].map((s) => docBySlug(s)!);
  return (
    <DocsShell
      nav={DOCS_NAV}
      current="/docs"
      eyebrow="Documentation"
      title="ContextForge documentation"
      description="Practical guides for the product as it exists today: a code graph you index, explore in the browser, and query from AI agents over MCP."
      pager={pagerFor("/docs")}
    >
      <div className="prose">
        <p>
          ContextForge parses repositories into a graph of files, classes, functions, methods
          and the relationships between them (imports, calls, inheritance) and stores that
          structure in Postgres. You can get at it two ways: the graph explorer in your browser,
          or the MCP endpoint, which coding agents query instead of grepping and reading files.
          It stores structure only, never your source code.
        </p>
        <blockquote>
          <p>
            Right now indexing runs in the self-hosted Docker stack, and the hosted deployment
            serves graphs that were indexed locally. Signing in with Google or GitHub, connecting
            repositories from GitHub and indexing in the cloud are{" "}
            <Link href="/roadmap">planned</Link>, but not built yet.
          </p>
        </blockquote>
      </div>

      <div className="grid-2" style={{ margin: "28px 0 40px" }}>
        {PATHS.map((p) => (
          <Link key={p.href} href={p.href} className="card">
            <h2 className="h3">{p.title}</h2>
            <p>{p.body}</p>
            <span className="link-arrow" aria-hidden="true">Open</span>
          </Link>
        ))}
      </div>

      <div className="prose">
        <h2 id="reference">Reference</h2>
        <ul>
          {refs.map((d) => (
            <li key={d.slug}>
              <Link href={`/docs/${d.slug}`}>{d.title}</Link>: {d.description}
            </li>
          ))}
        </ul>
        <p>
          The project behind ContextForge is <code>code-graph-mcp</code>. Configuration and
          identifiers keep that name: the MCP server is <code>code-graph</code>, and variables
          are named <code>CODE_GRAPH_*</code>.
        </p>
      </div>
    </DocsShell>
  );
}
