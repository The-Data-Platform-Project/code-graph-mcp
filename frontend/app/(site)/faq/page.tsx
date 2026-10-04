import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Common questions about ContextForge: what it is, how to use it, and how it handles your code.",
  alternates: { canonical: "/faq" },
};

type QA = { q: string; a: React.ReactNode };

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} style={{ color: "var(--accent-2)" }}>{children}</Link>
);

const SECTIONS: { title: string; items: QA[] }[] = [
  {
    title: "About ContextForge",
    items: [
      {
        q: "What is ContextForge?",
        a: <p>A code knowledge graph. It parses repositories into files, symbols and the relationships between them, stores that structure in Postgres, and serves it to people through a visual explorer and to AI agents through MCP.</p>,
      },
      {
        q: "Is it an AI chatbot for my code?",
        a: <p>No. ContextForge has no model and no chat. It answers structured queries — who calls this, what does this import — and your agent does the reasoning with the answers.</p>,
      },
      {
        q: "How is it different from searching the code?",
        a: <p>Text search finds strings. The graph knows that a name is a call to a specific function in a specific file, resolved through imports. Questions like &ldquo;everything that calls this&rdquo; or &ldquo;the call chain three levels down&rdquo; are one query instead of many searches and file reads.</p>,
      },
      {
        q: "Is it open source?",
        a: <p>Yes. The code is on <a href="https://github.com/The-Data-Platform-Project/code-graph-mcp" style={{ color: "var(--accent-2)" }}>GitHub</a> under the Apache License 2.0, as the <code>code-graph-mcp</code> project.</p>,
      },
      {
        q: "Is there pricing or a hosted sign-up?",
        a: <p>There is no public pricing. A hosted deployment can take sign-ups with GitHub: the administrator approves each account, which then gets its own graph. You can also self-host it today.</p>,
      },
    ],
  },
  {
    title: "Using it",
    items: [
      {
        q: "Which languages are supported?",
        a: <p>Python and JavaScript/TypeScript get a full symbol and call graph. HTML and Jinja templates, CSS, JSON (<code>package.json</code>) and YAML (Docker Compose) contribute dependencies, and other config files become searchable nodes. See the <A href="/docs/user-guide#supported-languages">user guide</A>.</p>,
      },
      {
        q: "How do I index a repository?",
        a: <p>Run the self-hosted stack, then call <code>index_repository(name, path)</code> over MCP — from Claude Code, for example. <A href="/docs/getting-started">Getting started</A> walks through it.</p>,
      },
      {
        q: "Can the hosted version index my GitHub repositories?",
        a: <p>Yes, when the deployment runs the cloud indexer. On the settings page, add a fine-grained GitHub token limited to the repositories you choose, then connect them. They are indexed straight away, then daily and on every push.</p>,
      },
      {
        q: "Does it keep the graph up to date automatically?",
        a: <p>Hosted with the cloud indexer, yes: connected repositories are re-indexed daily and on every push. Self-hosted, re-indexing is on demand with <code>reindex_repository</code>, which re-parses only files that changed.</p>,
      },
      {
        q: "Which AI agents work with it?",
        a: <p>ContextForge is tested with Claude Code. Any MCP client that supports streamable HTTP and a bearer-token header should work. See <A href="/docs/agents">working with AI agents</A>.</p>,
      },
      {
        q: "Does it cover branches or history?",
        a: <p>Not today: each repository is one snapshot, as it was when indexed. Branches and history are part of the long-term vision.</p>,
      },
      {
        q: "What does “unresolved” mean?",
        a: <p>A call the graph could not tie to a node — usually a library call, or a name that is ambiguous. ContextForge marks it rather than guessing.</p>,
      },
    ],
  },
  {
    title: "Data and security",
    items: [
      {
        q: "Does ContextForge store my source code?",
        a: <p>No. It stores names, locations and relationships. Source is read when you open it or an agent asks for a snippet — from your disk when self-hosted, from GitHub when hosted — and is never written to the database.</p>,
      },
      {
        q: "Does the indexer run my code?",
        a: <p>No. It only parses files. It never builds, installs or executes anything in a repository.</p>,
      },
      {
        q: "Who can reach my graph over MCP?",
        a: <p>Only someone with a token for that graph. Tokens are shown once, stored as a hash, tied to one graph, and revocable. Self-hosted, the server also listens on <code>127.0.0.1</code> only. See <A href="/docs/security">security and data handling</A>.</p>,
      },
    ],
  },
];

export default function FaqPage() {
  return (
    <>
      <header className="page-head">
        <div className="container">
          <span className="eyebrow">FAQ</span>
          <h1 className="display" style={{ fontSize: "clamp(36px, 5vw, 58px)" }}>Questions, answered plainly.</h1>
          <p className="lede">
            Can&apos;t find it here? The <A href="/docs">documentation</A> goes deeper.
          </p>
        </div>
      </header>
      <section className="section" style={{ paddingTop: 24 }}>
        <div className="container faq">
          {SECTIONS.map((s) => (
            <div key={s.title}>
              <h2 className="faq-cat">{s.title}</h2>
              <div style={{ display: "grid", gap: 10 }}>
                {s.items.map((it) => (
                  <details key={it.q}>
                    <summary>{it.q}</summary>
                    <div className="a">{it.a}</div>
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
