/**
 * Read-side graph queries, against one tenant's schema.
 *
 * These mirror src/code_graph/queries.py query for query — same SQL, same
 * ordering, same de-duplication, same output shape — because the MCP endpoint
 * can be answered by either implementation (MCP_BACKEND=native|proxy) and a
 * client must not be able to tell which. scripts/mcp_parity.py checks it.
 *
 * Every table reference goes through tbl(), which validates the schema.
 */
import { query } from "./pool";
import { tbl } from "./tenancy";

export type Repo = {
  name: string;
  path: string;
  indexed_at: string | null;
  node_count: number;
  edge_count: number;
  file_count: number;
};

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

const SYMBOL_KINDS = ["Class", "Function", "Method", "Interface", "Config", "Service"];
const MAX_TRACE_NODES = 500;
const MAX_TRACE_BREADTH = 50;
const MAX_NODES_PER_REPO = 3000;

// ── Tools ───────────────────────────────────────────────────────────────────

export async function listRepositories(schema: string): Promise<Repo[]> {
  return query<Repo>(
    `SELECT name, path, indexed_at, node_count, edge_count, file_count
       FROM ${tbl(schema, "repos")} ORDER BY name`,
  );
}

/** Mirrors util.like_pattern: `*`/`?` wildcards, otherwise a substring match. */
export function likePattern(pattern: string): string {
  if (pattern === "") return "%";
  const escaped = pattern.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const hasWildcard = pattern.includes("*") || pattern.includes("?");
  const translated = escaped.replace(/\*/g, "%").replace(/\?/g, "_");
  return hasWildcard ? translated : `%${translated}%`;
}

export async function searchSymbol(
  schema: string,
  pattern: string,
  repo?: string,
  limit = 100,
) {
  const like = likePattern(pattern);
  const params: unknown[] = [...SYMBOL_KINDS, like];
  const kinds = SYMBOL_KINDS.map((_, i) => `$${i + 1}`).join(",");
  const likeIdx = SYMBOL_KINDS.length + 1;
  let sql =
    `SELECT repo, kind, name, qualified_name, file_path, start_line, signature
       FROM ${tbl(schema, "nodes")}
      WHERE kind IN (${kinds})
        AND (name ILIKE $${likeIdx} ESCAPE '\\' OR qualified_name ILIKE $${likeIdx} ESCAPE '\\')`;
  if (repo) {
    params.push(repo);
    sql += ` AND repo = $${params.length}`;
  }
  params.push(Math.max(1, Math.min(Math.trunc(limit), 1000)));
  sql += ` ORDER BY name, qualified_name, repo LIMIT $${params.length}`;
  return query(sql, params);
}

export async function getCallers(schema: string, qname: string, repo?: string) {
  const params: unknown[] = ["CALLS", qname];
  let sql =
    `SELECT n.repo, n.kind, n.qualified_name, n.file_path, n.start_line, n.signature
       FROM ${tbl(schema, "edges")} e
       JOIN ${tbl(schema, "nodes")} n ON n.repo = e.repo AND n.qualified_name = e.src_qname
      WHERE e.edge_type = $1 AND e.dst_qname = $2 AND e.resolved = 1`;
  if (repo) {
    params.push(repo);
    sql += ` AND e.repo = $${params.length}`;
  }
  sql += " ORDER BY n.repo, n.qualified_name, n.kind, n.file_path";
  const rows = await query<{ repo: string; qualified_name: string }>(sql, params);
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.repo}\u0000${r.qualified_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getCallees(schema: string, qname: string, repo?: string) {
  const params: unknown[] = ["CALLS", qname];
  let sql =
    `SELECT e.dst_qname, e.dst_raw, e.resolved, e.repo,
            n.kind, n.file_path, n.start_line, n.signature
       FROM ${tbl(schema, "edges")} e
       LEFT JOIN ${tbl(schema, "nodes")} n
         ON n.repo = e.repo AND n.qualified_name = e.dst_qname
      WHERE e.edge_type = $1 AND e.src_qname = $2`;
  if (repo) {
    params.push(repo);
    sql += ` AND e.repo = $${params.length}`;
  }
  sql += " ORDER BY e.resolved DESC, e.dst_qname, e.repo, e.dst_raw";
  const rows = await query<{
    dst_qname: string; dst_raw: string; resolved: number; repo: string;
    kind: string | null; file_path: string | null; start_line: number | null;
    signature: string | null;
  }>(sql, params);
  const seen = new Set<string>();
  const out = [];
  for (const r of rows) {
    const resolved = Boolean(r.resolved);
    const target = resolved ? r.dst_qname : r.dst_raw;
    const key = `${r.repo}\u0000${target}\u0000${resolved}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      repo: r.repo, callee: target, resolved, kind: r.kind,
      file_path: r.file_path, start_line: r.start_line, signature: r.signature,
    });
  }
  return out;
}

type TraceNode = { qualified_name: string; cycle?: true; children?: TraceNode[] };

export async function traceCallPath(
  schema: string,
  qname: string,
  direction = "callees",
  depth = 3,
  repo?: string,
) {
  if (direction !== "callees" && direction !== "callers") {
    throw new Error("direction must be 'callees' or 'callers'");
  }
  const maxDepth = Math.max(1, Math.min(Math.trunc(depth), 20));
  const [pick, match] = direction === "callees"
    ? ["dst_qname", "src_qname"]
    : ["src_qname", "dst_qname"];
  const base =
    `SELECT DISTINCT ${pick} AS nb FROM ${tbl(schema, "edges")}
      WHERE edge_type = $1 AND ${match} = $2 AND resolved = 1`;

  const visited = new Set([qname]);
  let total = 0;
  let truncated = false;

  const neighbors = async (name: string): Promise<string[]> => {
    const params: unknown[] = ["CALLS", name];
    let sql = base;
    if (repo) {
      params.push(repo);
      sql += ` AND repo = $3`;
    }
    const rows = await query<{ nb: string }>(sql + " ORDER BY nb", params);
    return rows.map((r) => r.nb);
  };

  // Depth-first, same order as the Python version, so the two agree on which
  // branches get cut when a limit is hit.
  const expand = async (name: string, level: number): Promise<TraceNode> => {
    const node: TraceNode = { qualified_name: name };
    if (level >= maxDepth) return node;
    const children: TraceNode[] = [];
    for (const nb of await neighbors(name)) {
      if (total >= MAX_TRACE_NODES || children.length >= MAX_TRACE_BREADTH) {
        truncated = true;
        break;
      }
      if (visited.has(nb)) {
        children.push({ qualified_name: nb, cycle: true });
        continue;
      }
      visited.add(nb);
      total += 1;
      children.push(await expand(nb, level + 1));
    }
    if (children.length) node.children = children;
    return node;
  };

  const tree = await expand(qname, 0);
  return {
    root: qname,
    direction,
    depth: maxDepth,
    repo: repo ?? null,
    nodes_visited: total,
    truncated,
    tree,
  };
}

export async function getDependencies(schema: string, filePath: string, repo?: string) {
  const params: unknown[] = [filePath.replace(/\\/g, "/")];
  let sql =
    `SELECT i.repo, i.local_name, i.target, i.kind,
            EXISTS(SELECT 1 FROM ${tbl(schema, "nodes")} n
                    WHERE n.repo = i.repo AND n.qualified_name = i.target) AS in_project
       FROM ${tbl(schema, "imports")} i
      WHERE i.file_path = $1`;
  if (repo) {
    params.push(repo);
    sql += ` AND i.repo = $${params.length}`;
  }
  sql += " ORDER BY i.repo, i.target, i.local_name";
  const rows = await query<{
    repo: string; local_name: string; target: string; kind: string; in_project: boolean;
  }>(sql, params);
  return rows.map((r) => ({ ...r, in_project: Boolean(r.in_project) }));
}

export async function findNode(
  schema: string,
  qname: string,
  repo?: string,
): Promise<NodeRow | null> {
  const params: unknown[] = [qname];
  let sql =
    `SELECT repo, kind, name, qualified_name, file_path, start_line, end_line, signature
       FROM ${tbl(schema, "nodes")} WHERE qualified_name = $1`;
  if (repo) {
    params.push(repo);
    sql += ` AND repo = $${params.length}`;
  }
  // Prefer a concrete definition over a File node when names collide.
  sql += " ORDER BY CASE kind WHEN 'File' THEN 1 ELSE 0 END LIMIT 1";
  const rows = await query<NodeRow>(sql, params);
  return rows[0] ?? null;
}

// ── The page's connections panel ────────────────────────────────────────────

export async function getDependents(schema: string, repo: string, filePath: string) {
  const rows = await query<{ src_file: string; dst_qname: string }>(
    `SELECT DISTINCT e.src_file, e.dst_qname
       FROM ${tbl(schema, "edges")} e
       JOIN ${tbl(schema, "nodes")} n ON n.repo = e.repo AND n.qualified_name = e.dst_qname
      WHERE e.edge_type = $1 AND e.resolved = 1 AND e.repo = $2
        AND n.file_path = $3 AND e.src_file <> $3
      ORDER BY e.src_file LIMIT 200`,
    ["IMPORTS", repo, filePath],
  );
  return rows.map((r) => ({ repo, file_path: r.src_file, imported: r.dst_qname }));
}

export async function getFileSymbols(
  schema: string,
  repo: string,
  filePath: string,
  exclude?: string,
) {
  const rows = await query<{
    kind: string; name: string; qualified_name: string; start_line: number;
    signature: string | null;
  }>(
    `SELECT kind, name, qualified_name, start_line, signature
       FROM ${tbl(schema, "nodes")}
      WHERE repo = $1 AND file_path = $2 AND kind <> 'File'
      ORDER BY start_line LIMIT 200`,
    [repo, filePath],
  );
  return rows.filter((r) => r.qualified_name !== exclude);
}

/** Everything the connections panel shows for one node (as get_node_context). */
export async function nodeConnections(schema: string, node: NodeRow) {
  const [callers, callees, dependencies, dependents, siblings] = await Promise.all([
    getCallers(schema, node.qualified_name, node.repo),
    getCallees(schema, node.qualified_name, node.repo),
    getDependencies(schema, node.file_path, node.repo),
    getDependents(schema, node.repo, node.file_path),
    getFileSymbols(schema, node.repo, node.file_path, node.qualified_name),
  ]);
  return { callers, callees, dependencies, dependents, siblings };
}

// ── The page's graph canvas ─────────────────────────────────────────────────

export type GraphPayload = {
  nodes: Array<{
    id: string; name: string; kind: string; repo: string; file_path: string;
    start_line: number; end_line: number; signature: string | null;
  }>;
  links: Array<{ source: string; target: string; type: string; repo: string }>;
  repos: Repo[];
  stats: { nodes: number; edges: number; files: number };
};

/** The {nodes, links, repos, stats} payload (as graph_export.build_payload). */
export async function graphPayload(schema: string): Promise<GraphPayload> {
  const repos = await listRepositories(schema);
  const nodes: GraphPayload["nodes"] = [];
  for (const r of repos) {
    // Per repo, so one large repository cannot crowd every other one out.
    nodes.push(
      ...(await query<GraphPayload["nodes"][number]>(
        `SELECT qualified_name AS id, name, kind, repo, file_path,
                start_line, end_line, signature
           FROM ${tbl(schema, "nodes")} WHERE repo = $1
          ORDER BY kind, name LIMIT $2`,
        [r.name, MAX_NODES_PER_REPO],
      )),
    );
  }
  const ids = new Set(nodes.map((n) => n.id));
  const links = (
    await query<GraphPayload["links"][number]>(
      `SELECT src_qname AS source, dst_qname AS target, edge_type AS type, repo
         FROM ${tbl(schema, "edges")}`,
    )
  ).filter((l) => ids.has(l.source) && ids.has(l.target));
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
