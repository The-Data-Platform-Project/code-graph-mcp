import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Roadmap",
  description:
    "Where ContextForge is going, by capability: what is available today and what is planned. No dates.",
  alternates: { canonical: "/roadmap" },
};

type Status = "available" | "planned" | "vision";
type Item = { title: string; body: string; status: Status };
type Group = { title: string; blurb: string; items: Item[] };

const LABEL: Record<Status, string> = { available: "Available", planned: "Planned", vision: "Vision" };

const GROUPS: Group[] = [
  {
    title: "Identity and access",
    blurb: "Who can sign in, and what they can reach.",
    items: [
      { title: "Owner sign-in", body: "A break-glass owner password with a signed session.", status: "available" },
      { title: "Personal MCP tokens", body: "Hashed, shown once, scoped to one graph, revocable by the administrator.", status: "available" },
      { title: "Sign in with GitHub", body: "Accounts for other people. GitHub is asked only who they are; repository access is granted separately, per token.", status: "available" },
      { title: "Owner approval", body: "New accounts wait for approval on the settings page; approving one provisions its own graph.", status: "available" },
      { title: "Sign in with Google", body: "A second identity provider for people without GitHub accounts.", status: "planned" },
      { title: "Admin portal", body: "Graphs, tokens, index jobs and an audit log in one place, beyond today's approvals on the settings page.", status: "planned" },
      { title: "Self-service tokens and hardening", body: "Minting your own tokens, token expiry, rate limits and per-user quotas.", status: "planned" },
    ],
  },
  {
    title: "Repository connectivity",
    blurb: "How code gets in.",
    items: [
      { title: "Local repositories", body: "Any repository under a directory mounted read-only into the self-hosted stack.", status: "available" },
      { title: "GitHub source previews", body: "The hosted explorer reads source from each graph's connected GitHub repository.", status: "available" },
      { title: "Fine-grained GitHub tokens", body: "Keep several tokens, each limited on GitHub to the repositories you choose. Requested from the settings page with read-only permissions filled in, and stored encrypted.", status: "available" },
    ],
  },
  {
    title: "Indexing",
    blurb: "Turning code into a graph, and keeping it current.",
    items: [
      { title: "Full and incremental indexing", body: "Self-hosted, on demand; re-indexing parses only changed files.", status: "available" },
      { title: "Cloud indexing", body: "A job queue and indexing workers on AWS Lambda, with each run's status and errors on the settings page.", status: "available" },
      { title: "Automatic refresh", body: "Re-indexing once a day and on every push, through a GitHub webhook or a GitHub Actions workflow.", status: "available" },
    ],
  },
  {
    title: "Graph intelligence",
    blurb: "What the graph knows.",
    items: [
      { title: "Symbols and relationships", body: "Files, classes, functions, methods, interfaces, config files and services; imports, calls, inheritance, implementation and type use.", status: "available" },
      { title: "Cross-language resolution", body: "HTML to scripts and styles, templates to templates and macros, services to services.", status: "available" },
      { title: "More languages and relationships", body: "Additional language extractors and relationship types.", status: "planned" },
      { title: "Architectural grouping", body: "Grouping by application area and across repositories in an organization.", status: "planned" },
    ],
  },
  {
    title: "Developer experience",
    blurb: "Exploring and retrieving context.",
    items: [
      { title: "Graph explorer", body: "Repository selector, search, filters, and source and connections for every node.", status: "available" },
      { title: "MCP for agents", body: "Seven read tools, identical hosted and self-hosted.", status: "available" },
      { title: "Richer navigation", body: "Progressive, expand-as-you-go exploration and multi-repository views.", status: "planned" },
    ],
  },
  {
    title: "Historical intelligence",
    blurb: "Code over time.",
    items: [
      { title: "Branches", body: "Graphs for more than one branch of a repository.", status: "vision" },
      { title: "Commits and change analysis", body: "The graph as it was at any commit, and what a change touched.", status: "vision" },
    ],
  },
];

export default function RoadmapPage() {
  return (
    <>
      <header className="page-head">
        <div className="container">
          <span className="eyebrow">Roadmap</span>
          <h1 className="display" style={{ fontSize: "clamp(36px, 5vw, 58px)" }}>
            Where ContextForge is going.
          </h1>
          <p className="lede">
            Organized by capability, not by date. <b>Available</b> means you can use it today.{" "}
            <b>Planned</b> means designed but not built. <b>Vision</b> means longer-term
            direction. Nothing here is a delivery commitment.
          </p>
          <div className="legend-row">
            <span className="badge badge-available">Available</span>
            <span className="badge badge-planned">Planned</span>
            <span className="badge badge-vision">Vision</span>
          </div>
        </div>
      </header>

      <section className="section" style={{ paddingTop: 40 }}>
        <div className="container">
          {GROUPS.map((g) => (
            <div className="rm-group" key={g.title}>
              <div>
                <h2>{g.title}</h2>
                <p>{g.blurb}</p>
              </div>
              <div className="rm-items">
                {g.items.map((it) => (
                  <div className="rm-item" key={it.title}>
                    <div>
                      <h3>{it.title}</h3>
                      <p>{it.body}</p>
                    </div>
                    <span className={`badge badge-${it.status}`}>{LABEL[it.status]}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="muted" style={{ marginTop: 32 }}>
            What works today is documented in the <Link href="/docs/user-guide" style={{ color: "var(--accent-2)" }}>user guide</Link>;
            what does not is listed in <Link href="/docs/limitations" style={{ color: "var(--accent-2)" }}>limitations</Link>.
          </p>
        </div>
      </section>
    </>
  );
}
