/**
 * The public documentation: order, navigation and content.
 *
 * Content lives in content/docs/*.md and is imported as strings (see
 * next.config.mjs), so every page is rendered at build time. The admin guide
 * is deliberately NOT here: it is protected, and lives in lib/admin-guide.ts.
 */
import agents from "@/content/docs/agents.md";
import api from "@/content/docs/api.md";
import architecture from "@/content/docs/architecture.md";
import explorer from "@/content/docs/explorer.md";
import gettingStarted from "@/content/docs/getting-started.md";
import limitations from "@/content/docs/limitations.md";
import security from "@/content/docs/security.md";
import troubleshooting from "@/content/docs/troubleshooting.md";
import userGuide from "@/content/docs/user-guide.md";

export type DocPage = {
  slug: string;
  title: string;
  /** One sentence: the page's lede and its meta description. */
  description: string;
  body: string;
};

export const DOCS: DocPage[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    description:
      "Run ContextForge with Docker, index your first repository, and open it in the explorer and in Claude Code.",
    body: gettingStarted,
  },
  {
    slug: "user-guide",
    title: "User guide",
    description:
      "Everything ContextForge does today, from indexing a repository to handing its graph to an agent.",
    body: userGuide,
  },
  {
    slug: "explorer",
    title: "Graph explorer",
    description:
      "Navigate a repository's graph: choose a repository, search, filter, and inspect any symbol's source and connections.",
    body: explorer,
  },
  {
    slug: "agents",
    title: "Working with AI agents",
    description:
      "Connect Claude Code, or another MCP client, to a ContextForge graph and use it in real workflows.",
    body: agents,
  },
  {
    slug: "api",
    title: "MCP tool reference",
    description:
      "Every MCP tool ContextForge serves: arguments, results and real examples.",
    body: api,
  },
  {
    slug: "architecture",
    title: "Architecture",
    description:
      "How source code becomes a graph: parsing, extraction, resolution, storage, and the two ways the graph is served.",
    body: architecture,
  },
  {
    slug: "security",
    title: "Security and data handling",
    description:
      "What ContextForge stores, what it never stores, and how access to a graph is controlled.",
    body: security,
  },
  {
    slug: "limitations",
    title: "Limitations",
    description: "What ContextForge does not do yet, stated plainly.",
    body: limitations,
  },
  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    description: "Common failures, what causes them, and how to fix them.",
    body: troubleshooting,
  },
];

export const docBySlug = (slug: string) => DOCS.find((d) => d.slug === slug);

export type NavGroup = { title: string; items: { href: string; label: string }[] };

const item = (slug: string) => ({ href: `/docs/${slug}`, label: docBySlug(slug)!.title });

export const DOCS_NAV: NavGroup[] = [
  {
    title: "Start here",
    items: [{ href: "/docs", label: "Overview" }, item("getting-started"), item("user-guide")],
  },
  { title: "Use it", items: [item("explorer"), item("agents"), item("api")] },
  {
    title: "Reference",
    items: [item("architecture"), item("security"), item("limitations"), item("troubleshooting")],
  },
];

/** Previous and next pages, following the sidebar order. */
export function pagerFor(href: string) {
  const flat = DOCS_NAV.flatMap((g) => g.items);
  const i = flat.findIndex((x) => x.href === href);
  return { prev: i > 0 ? flat[i - 1] : null, next: i >= 0 && i < flat.length - 1 ? flat[i + 1] : null };
}
