/**
 * Read-side graph queries, straight against Postgres.
 *
 * These mirror `src/code_graph/queries.py` — the Python service still owns
 * writing the graph and reading source files, but the app reads structure
 * itself so that a page view costs one database round trip instead of a round
 * trip through the tunnel to the user's machine.
 */
import { Pool } from "pg";
import { databaseUrl } from "./env";

// One pool per lambda/container instance. `max` is small on purpose: Vercel
// runs many instances, and a hosted Postgres (Supabase) has a modest
// connection ceiling — see docs/SUPABASE.md on using the pooler port.
const globalForPool = globalThis as unknown as { _cgPool?: Pool };

export function pool(): Pool {
  if (!globalForPool._cgPool) {
    globalForPool._cgPool = new Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.PGPOOL_MAX ?? 3),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return globalForPool._cgPool;
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool().query(sql, params);
  return result.rows as T[];
}

export type Repo = {
  name: string;
  path: string;
  indexed_at: string | null;
  node_count: number;
  edge_count: number;
  file_count: number;
};

export type GraphNode = {
  id: string;
  name: string;
  kind: string;
  repo: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
};

export type GraphLink = {
  source: string;
  target: string;
  type: string;
  repo: string;
};

export type GraphPayload = {
  nodes: GraphNode[];
  links: GraphLink[];
  repos: Repo[];
  stats: { nodes: number; edges: number; files: number };
};

const MAX_NODES_PER_REPO = 3000;

export async function listRepos(): Promise<Repo[]> {
  return query<Repo>(
    `SELECT name, path, indexed_at, node_count, edge_count, file_count
       FROM repos ORDER BY name`,
  );
}

/** The {nodes, links, repos, stats} payload the graph canvas consumes. */
export async function graphPayload(repo?: string): Promise<GraphPayload> {
  const repos = await listRepos();
  const wanted = repo ? repos.filter((r) => r.name === repo) : repos;

  const nodes: GraphNode[] = [];
  for (const r of wanted) {
    // Per repo, so one large repository cannot crowd out every other one.
    const rows = await query<GraphNode>(
      `SELECT qualified_name AS id, name, kind, repo, file_path,
              start_line, end_line, signature
         FROM nodes WHERE repo = $1 ORDER BY kind, name LIMIT $2`,
      [r.name, MAX_NODES_PER_REPO],
    );
    nodes.push(...rows);
  }

  const ids = new Set(nodes.map((n) => n.id));
  const edgeRows = await query<GraphLink>(
    wanted.length === repos.length
      ? `SELECT src_qname AS source, dst_qname AS target, edge_type AS type, repo
           FROM edges`
      : `SELECT src_qname AS source, dst_qname AS target, edge_type AS type, repo
           FROM edges WHERE repo = ANY($1)`,
    wanted.length === repos.length ? [] : [wanted.map((r) => r.name)],
  );
  const links = edgeRows.filter((l) => ids.has(l.source) && ids.has(l.target));

  return {
    nodes,
    links,
    repos,
    stats: {
      nodes: nodes.length,
      edges: links.filter((l) => l.type !== "CONTAINS").length,
      files: new Set(nodes.map((n) => n.file_path)).size,
    },
  };
}

export type NodeRow = {
  repo: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
};

export async function findNode(
  qname: string,
  repo?: string,
): Promise<NodeRow | null> {
  const rows = await query<NodeRow>(
    `SELECT repo, kind, name, qualified_name, file_path, start_line, end_line,
            signature
       FROM nodes
      WHERE qualified_name = $1 ${repo ? "AND repo = $2" : ""}
      -- Prefer a concrete definition over a File node when names collide.
      ORDER BY CASE kind WHEN 'File' THEN 1 ELSE 0 END
      LIMIT 1`,
    repo ? [qname, repo] : [qname],
  );
  return rows[0] ?? null;
}

/** Callers, callees, imports, importers and siblings — the "connections" view. */
export async function connections(node: NodeRow) {
  const { repo, qualified_name: qname, file_path: file } = node;

  const [callers, callees, dependencies, dependents, siblings] =
    await Promise.all([
      query(
        `SELECT DISTINCT n.repo, n.kind, n.qualified_name, n.file_path,
                n.start_line, n.signature
           FROM edges e
           JOIN nodes n ON n.repo = e.repo AND n.qualified_name = e.src_qname
          WHERE e.edge_type = 'CALLS' AND e.dst_qname = $1
            AND e.resolved = 1 AND e.repo = $2
          ORDER BY n.qualified_name`,
        [qname, repo],
      ),
      query(
        `SELECT DISTINCT
                CASE WHEN e.resolved = 1 THEN e.dst_qname ELSE e.dst_raw END
                  AS callee,
                e.resolved, n.kind, n.file_path, n.start_line, n.signature
           FROM edges e
           LEFT JOIN nodes n
             ON n.repo = e.repo AND n.qualified_name = e.dst_qname
          WHERE e.edge_type = 'CALLS' AND e.src_qname = $1 AND e.repo = $2
          ORDER BY e.resolved DESC, callee`,
        [qname, repo],
      ),
      query(
        `SELECT i.local_name, i.target, i.kind,
                EXISTS(SELECT 1 FROM nodes n
                        WHERE n.repo = i.repo AND n.qualified_name = i.target)
                  AS in_project
           FROM imports i
          WHERE i.file_path = $1 AND i.repo = $2
          ORDER BY i.target`,
        [file, repo],
      ),
      query(
        `SELECT DISTINCT e.src_file AS file_path, e.dst_qname AS imported
           FROM edges e
           JOIN nodes n ON n.repo = e.repo AND n.qualified_name = e.dst_qname
          WHERE e.edge_type = 'IMPORTS' AND e.resolved = 1
            AND e.repo = $1 AND n.file_path = $2 AND e.src_file <> $2
          ORDER BY e.src_file
          LIMIT 200`,
        [repo, file],
      ),
      query(
        `SELECT kind, name, qualified_name, start_line, signature
           FROM nodes
          WHERE repo = $1 AND file_path = $2 AND kind <> 'File'
            AND qualified_name <> $3
          ORDER BY start_line LIMIT 200`,
        [repo, file, qname],
      ),
    ]);

  return { callers, callees, dependencies, dependents, siblings };
}

export async function searchSymbols(pattern: string, repo?: string) {
  // ILIKE: the search is documented as a case-insensitive substring match.
  const like = `%${pattern.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  return query<NodeRow>(
    `SELECT repo, kind, name, qualified_name, file_path, start_line, signature
       FROM nodes
      WHERE kind IN ('Class','Function','Method','Interface','Config','Service')
        AND (name ILIKE $1 ESCAPE '\\' OR qualified_name ILIKE $1 ESCAPE '\\')
        ${repo ? "AND repo = $2" : ""}
      ORDER BY name LIMIT 100`,
    repo ? [like, repo] : [like],
  );
}
