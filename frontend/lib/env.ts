/**
 * Runtime configuration, read from the environment.
 *
 * The split that shapes this app: graph *structure* comes from Postgres
 * (Supabase in production), where each tenant's graph lives in its own schema.
 * Source *text* is never stored, so it comes from a pluggable provider —
 * GitHub in the cloud, or the code-graph container when running locally.
 *
 * Every secret here is read server-side only; none is ever sent to a browser.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. See docs/ADMIN_GUIDE.md for the environment variables.`,
    );
  }
  return value;
}

export function databaseUrl(): string {
  return required("DATABASE_URL");
}

/**
 * PEM of the CA that signs the database's certificate (Supabase: Database
 * settings → SSL configuration → download). Env vars cannot always hold
 * newlines, so a literal "\n" is accepted in place of each one.
 */
export function databaseCaCert(): string {
  return (process.env.DATABASE_CA_CERT ?? "").replace(/\\n/g, "\n").trim();
}

/** The tenant the owner's login maps to, until real sign-in exists. */
export function ownerTenantSlug(): string {
  return process.env.OWNER_TENANT_SLUG?.trim() || "owner";
}

export function ownerPassword(): string {
  const value = required("OWNER_PASSWORD");
  // A single shared password is the only thing in front of this page until
  // Supabase Auth lands, so refuse a weak one rather than run with it.
  if (value.length < 12) {
    throw new Error("OWNER_PASSWORD must be at least 12 characters.");
  }
  return value;
}

export function sessionSecret(): string {
  const value = required("SESSION_SECRET");
  if (value.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters (openssl rand -hex 32).");
  }
  return value;
}

// ── Sign-in with GitHub ─────────────────────────────────────────────────────

/**
 * The GitHub OAuth app people sign up with, or null when it is not set up (the
 * login page then offers only the owner password). Sign-in asks GitHub for
 * identity only (`read:user user:email`); repository access comes from the
 * fine-grained tokens people add on /settings.
 */
export function githubOAuth(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * The owner's GitHub login. Signing in with it lands in the owner's existing
 * tenant as a platform admin, with no approval step; everyone else waits for
 * the owner to approve them.
 */
export function ownerGithubLogin(): string {
  return process.env.OWNER_GITHUB_LOGIN?.trim().toLowerCase() ?? "";
}

/** The site's own origin, when the request's cannot be trusted (proxies). */
export function publicAppUrl(): string {
  return process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "") ?? "";
}

/** The AES-256-GCM key GitHub tokens are sealed with (lib/secretbox.ts). */
export function githubTokenKeyHex(): string {
  return required("GITHUB_TOKEN_KEY");
}

// ── The cloud indexer (infra/aws) ───────────────────────────────────────────

/** The indexer's Function URL, or "" when no indexer is deployed. */
export function indexerUrl(): string {
  return process.env.INDEXER_URL?.trim().replace(/\/+$/, "") ?? "";
}

/**
 * Shared with the indexer: signs "Index now" requests and derives each
 * connection's GitHub webhook secret (lib/indexer.ts, etl/signing.py).
 */
export function indexerSecret(): string {
  return process.env.INDEXER_SECRET?.trim() ?? "";
}

// ── Source text ─────────────────────────────────────────────────────────────

export type SourceProvider = "github" | "mcp" | "none";

/**
 * Where README and file text come from.
 * - github: the repo recorded in control.repo_connections, via the GitHub API
 * - mcp:    the code-graph container's /api/file (local / tunnelled setups)
 * - none:   previews switched off; the graph still works
 */
export function sourceProvider(): SourceProvider {
  const value = (process.env.SOURCE_PROVIDER ?? "github").trim().toLowerCase();
  if (value === "github" || value === "mcp" || value === "none") return value;
  throw new Error(`SOURCE_PROVIDER must be github, mcp or none (got "${value}").`);
}

/** Optional: raises GitHub's rate limit and unlocks private repos. */
export function githubToken(): string {
  return process.env.GITHUB_TOKEN?.trim() ?? "";
}

export function mcpBaseUrl(): string {
  // e.g. http://code-graph-mcp:8765 locally, or a tunnel URL.
  return required("MCP_BASE_URL").replace(/\/+$/, "");
}

export function mcpToken(): string {
  return process.env.CODE_GRAPH_TOKEN ?? "";
}

// ── The MCP endpoint this app exposes ───────────────────────────────────────

export type McpBackend = "native" | "proxy";

/**
 * Who answers /api/mcp.
 * - native: the tools implemented in this app, against Postgres
 * - proxy:  forward to an upstream MCP server (the Python one, once it runs
 *           on a container), so clients keep the same URL either way
 */
export function mcpBackend(): McpBackend {
  const value = (process.env.MCP_BACKEND ?? "native").trim().toLowerCase();
  if (value === "native" || value === "proxy") return value;
  throw new Error(`MCP_BACKEND must be native or proxy (got "${value}").`);
}

export function mcpUpstreamUrl(): string {
  return required("MCP_UPSTREAM_URL").replace(/\/+$/, "");
}

export function mcpUpstreamToken(): string {
  return process.env.MCP_UPSTREAM_TOKEN ?? "";
}
