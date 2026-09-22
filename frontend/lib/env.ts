/**
 * Runtime configuration, read from the environment.
 *
 * The split that shapes this whole app: graph *structure* comes from Postgres
 * (reachable from anywhere, and the thing that later becomes Supabase), while
 * source *text* comes from the code-graph container, because only that machine
 * has the repositories on disk. Vercel therefore needs both a DATABASE_URL and
 * a tunnelled MCP_BASE_URL.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. See docker-compose.yml for local values, or the ` +
        `project README for the Vercel environment variables.`,
    );
  }
  return value;
}

export function databaseUrl(): string {
  return required("DATABASE_URL");
}

export function mcpBaseUrl(): string {
  // e.g. http://code-graph-mcp:8765 locally, or the https ngrok URL on Vercel.
  return required("MCP_BASE_URL").replace(/\/+$/, "");
}

export function mcpToken(): string {
  return process.env.CODE_GRAPH_TOKEN ?? "";
}

/**
 * Where graph *structure* is read from.
 *
 * - "postgres": query the database directly. Fastest, and what compose uses
 *   locally. On Vercel this needs a database reachable from the internet,
 *   i.e. Supabase (docs/SUPABASE.md).
 * - "mcp": ask the code-graph container over the tunnel, exactly as source
 *   text is fetched. Slower and it needs the machine awake, but it works on
 *   Vercel with no hosted database at all.
 *
 * Defaults to postgres when a DATABASE_URL exists, otherwise mcp — so a Vercel
 * deployment configured with only the tunnel URL just works.
 */
export function graphSource(): "postgres" | "mcp" {
  const explicit = (process.env.GRAPH_SOURCE ?? "").trim().toLowerCase();
  if (explicit === "postgres" || explicit === "mcp") return explicit;
  return process.env.DATABASE_URL ? "postgres" : "mcp";
}
