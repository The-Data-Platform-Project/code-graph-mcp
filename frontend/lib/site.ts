/**
 * Site-wide constants for the public ContextForge pages.
 *
 * SITE_URL is the canonical origin used in metadata, the sitemap and social
 * cards. It defaults to the intended domain; until contextforge.ai is pointed
 * at the Vercel project, set SITE_URL to the deployment's own URL if canonical
 * links should resolve.
 */
export const SITE = {
  name: "ContextForge",
  tagline: "Build context your agents can use.",
  description:
    "ContextForge turns source code into a connected, queryable graph of files, " +
    "symbols and their relationships, and serves it to AI agents over MCP.",
  url: (process.env.SITE_URL ?? "https://contextforge.ai").replace(/\/$/, ""),
  github: "https://github.com/The-Data-Platform-Project/code-graph-mcp",
  license: "https://github.com/The-Data-Platform-Project/code-graph-mcp/blob/main/LICENSE",
} as const;

/** Where "Launch" goes: the explorer, which sends signed-out visitors to /login. */
export const APP_PATH = "/graph";

export type NavLink = { href: string; label: string; external?: boolean };

export const HEADER_NAV: NavLink[] = [
  { href: "/product", label: "Product" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/docs", label: "Docs" },
  { href: "/roadmap", label: "Roadmap" },
  { href: SITE.github, label: "GitHub", external: true },
];

export const FOOTER_GROUPS: { title: string; links: NavLink[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/product", label: "Capabilities" },
      { href: "/#how-it-works", label: "How it works" },
      { href: "/roadmap", label: "Roadmap" },
      { href: APP_PATH, label: "Launch app" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/docs/getting-started", label: "Getting started" },
      { href: "/docs/agents", label: "Agent integration" },
      { href: "/docs/api", label: "MCP tool reference" },
      { href: "/docs/architecture", label: "Architecture" },
    ],
  },
  {
    title: "Documentation",
    links: [
      { href: "/docs/user-guide", label: "User guide" },
      { href: "/docs/explorer", label: "Graph explorer" },
      { href: "/docs/security", label: "Security and data" },
      { href: "/docs/troubleshooting", label: "Troubleshooting" },
    ],
  },
  {
    title: "Resources",
    links: [
      { href: SITE.github, label: "GitHub", external: true },
      { href: "/faq", label: "FAQ" },
      { href: "/docs/limitations", label: "Limitations" },
    ],
  },
  {
    title: "Legal",
    links: [{ href: SITE.license, label: "License (Apache-2.0)", external: true }],
  },
];
