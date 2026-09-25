/**
 * The code graph's MCP tools, served from the Next.js app.
 *
 * The tool names, arguments, descriptions and result shapes mirror the Python
 * server (src/code_graph/server.py) exactly, so a Claude Code client cannot
 * tell which one answered and MCP_BACKEND can switch between them without the
 * client changing anything. scripts/mcp_parity.py checks that they agree.
 *
 * Result shape, as FastMCP produces it:
 *   list results  one text item per element, plus structuredContent {result: [...]}
 *   dict results  one text item, plus structuredContent = the dict
 *
 * Every tool is bound to one tenant's schema when the server is built; nothing
 * a caller passes can name another schema. The indexing tools are absent: the
 * cloud has no workspace to index (see docs/FUTURE_STATE.md for where
 * per-user indexing goes).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  findNode,
  getCallees,
  getCallers,
  getDependencies,
  listRepositories,
  searchSymbol,
  traceCallPath,
} from "./graph";
import { readFile } from "./source";
import type { Tenant } from "./tenancy";

const INSTRUCTIONS =
  "A persistent code knowledge graph. Answer structural questions " +
  "(callers, callees, call paths, dependencies, symbol search) with a " +
  "single graph query instead of grep/read chains.";

// Python's json.dumps(indent=2) separators, so text content matches byte for byte
// for ASCII data. (Python escapes non-ASCII; the structured copy is the one to
// compare on.)
function dumps(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function listResult(items: unknown[]): CallToolResult {
  return {
    content: items.map((item) => ({ type: "text", text: dumps(item) })),
    structuredContent: { result: items },
  };
}

function dictResult(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: dumps(value) }], structuredContent: value };
}

// FastMCP's outputSchema for list[dict[str, Any]] returns.
const LIST_OUTPUT = { result: z.array(z.record(z.string(), z.any())) };

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** Python's str.splitlines(): the line boundaries it recognises, no trailing empty. */
function splitlines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function codeSnippet(tenant: Tenant, qname: string, repo?: string) {
  const node = await findNode(tenant.schema, qname, repo);
  if (!node) return { error: `no node named '${qname}'`, found: false };
  const source = await readFile(tenant, node.repo, node.file_path);
  if (!source.found) return { error: source.error, found: false };
  const start = node.start_line;
  const end = node.end_line;
  return {
    found: true,
    repo: node.repo,
    qualified_name: node.qualified_name,
    kind: node.kind,
    file_path: node.file_path,
    start_line: start,
    end_line: end,
    signature: node.signature,
    code: splitlines(source.content).slice(start - 1, end).join("\n"),
  };
}

export function buildMcpServer(tenant: Tenant): McpServer {
  const server = new McpServer(
    { name: "code-graph", version: "0.2.0" },
    { instructions: INSTRUCTIONS },
  );
  const schema = tenant.schema;
  const repoArg = z.string().optional().describe("optional repo name");

  server.registerTool(
    "list_repositories",
    {
      description: "List indexed repositories with their node, edge and file counts.",
      outputSchema: LIST_OUTPUT,
      annotations: READ_ONLY,
    },
    async () => listResult(await listRepositories(schema)),
  );

  server.registerTool(
    "search_symbol",
    {
      description:
        "Find functions, methods, classes or interfaces by name pattern.\n\n" +
        "Args:\n    pattern: substring, or a glob with '*' / '?' wildcards.\n" +
        "    repo: optional repo name to scope the search.\n" +
        "    limit: maximum results (default 100).",
      inputSchema: {
        pattern: z.string(),
        repo: repoArg,
        limit: z.number().int().optional(),
      },
      outputSchema: LIST_OUTPUT,
      annotations: READ_ONLY,
    },
    async ({ pattern, repo, limit }) =>
      listResult(await searchSymbol(schema, pattern, repo, limit ?? 100)),
  );

  server.registerTool(
    "get_callers",
    {
      description:
        "Return the functions/methods that call `qualified_name`.\n\n" +
        'Args:\n    qualified_name: fully-qualified name, e.g. "pkg.mod.Class.method".\n' +
        "    repo: optional repo name to disambiguate across repos.",
      inputSchema: { qualified_name: z.string(), repo: repoArg },
      outputSchema: LIST_OUTPUT,
      annotations: READ_ONLY,
    },
    async ({ qualified_name, repo }) =>
      listResult(await getCallers(schema, qualified_name, repo)),
  );

  server.registerTool(
    "get_callees",
    {
      description:
        "Return what `qualified_name` calls (resolved targets and honest unresolved).\n\n" +
        "Args:\n    qualified_name: fully-qualified name of the caller.\n" +
        "    repo: optional repo name to disambiguate across repos.",
      inputSchema: { qualified_name: z.string(), repo: repoArg },
      outputSchema: LIST_OUTPUT,
      annotations: READ_ONLY,
    },
    async ({ qualified_name, repo }) =>
      listResult(await getCallees(schema, qualified_name, repo)),
  );

  server.registerTool(
    "trace_call_path",
    {
      description:
        "Breadth-first traversal of the call graph, depth-limited.\n\n" +
        "Args:\n    qualified_name: starting symbol.\n" +
        '    direction: "callees" (what it calls, downstream) or "callers" (upstream).\n' +
        "    depth: maximum levels to traverse (1-20, default 3).\n" +
        "    repo: optional repo name to scope the traversal.",
      inputSchema: {
        qualified_name: z.string(),
        direction: z.string().optional(),
        depth: z.number().int().optional(),
        repo: repoArg,
      },
      annotations: READ_ONLY,
    },
    async ({ qualified_name, direction, depth, repo }) => {
      try {
        return dictResult(
          await traceCallPath(schema, qualified_name, direction ?? "callees", depth ?? 3, repo),
        );
      } catch (err) {
        // The Python tool turns a bad direction into {"error": ...}, not a fault.
        return dictResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  server.registerTool(
    "get_dependencies",
    {
      description:
        "Return the imports of a file (repo-relative path), flagged in-project or not.\n\n" +
        'Args:\n    file_path: repo-relative path, e.g. "pkg/module.py".\n' +
        "    repo: optional repo name to disambiguate if the path exists in several.",
      inputSchema: { file_path: z.string(), repo: repoArg },
      outputSchema: LIST_OUTPUT,
      annotations: READ_ONLY,
    },
    async ({ file_path, repo }) => listResult(await getDependencies(schema, file_path, repo)),
  );

  server.registerTool(
    "get_code_snippet",
    {
      description:
        "Return the source text of a symbol, read fresh from its source (never stored).\n\n" +
        "Args:\n    qualified_name: fully-qualified name of the symbol.\n" +
        "    repo: optional repo name to disambiguate across repos.",
      inputSchema: { qualified_name: z.string(), repo: repoArg },
      // Reads the connected GitHub repo when SOURCE_PROVIDER=github.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ qualified_name, repo }) =>
      dictResult(await codeSnippet(tenant, qualified_name, repo)),
  );

  return server;
}
