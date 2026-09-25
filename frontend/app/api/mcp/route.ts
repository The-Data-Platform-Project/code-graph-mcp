/**
 * The MCP endpoint Claude Code connects to: POST /api/mcp (streamable HTTP).
 *
 * Authentication is a per-tenant bearer token (control.mcp_tokens, minted with
 * scripts/mcp_token.py). The token decides the tenant; the tenant decides the
 * schema; nothing in the request can widen that. Middleware leaves this path
 * open because it is authenticated here, by token rather than by cookie.
 *
 * MCP_BACKEND picks who answers, behind the same URL:
 *   native  tools implemented in this app (lib/mcpServer.ts), stateless: a
 *           fresh server per request, JSON responses — fits serverless.
 *   proxy   forward the request to MCP_UPSTREAM_URL (the Python server on a
 *           container), swapping the client's token for MCP_UPSTREAM_TOKEN.
 *           The upstream exposes its full tool set, indexing included, and
 *           serves only the owner tenant until it learns x-code-graph-tenant.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { tenantByToken } from "@/lib/control";
import { mcpBackend, mcpUpstreamToken, mcpUpstreamUrl, ownerTenantSlug } from "@/lib/env";
import { buildMcpServer } from "@/lib/mcpServer";
import type { Tenant } from "@/lib/tenancy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function jsonRpcError(status: number, code: number, message: string, extra?: HeadersInit) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

async function authenticate(req: Request): Promise<Tenant | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  return tenantByToken(match[1]);
}

async function native(req: Request, tenant: Tenant): Promise<Response> {
  if (req.method !== "POST") {
    // Stateless: no standalone SSE stream to GET and no session to DELETE.
    return jsonRpcError(405, -32000, "Method not allowed.", { Allow: "POST" });
  }
  const server = buildMcpServer(tenant);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // With JSON responses the body is complete by the time handleRequest resolves.
    void server.close();
  }
}

// Only what the streamable HTTP protocol uses crosses the proxy, in either direction.
const FORWARD_REQUEST = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARD_RESPONSE = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];

async function proxy(req: Request, tenant: Tenant): Promise<Response> {
  // The upstream serves one graph today — the owner's — so no other tenant's
  // token may be forwarded to it, or it would read the owner's graph.
  if (tenant.slug !== ownerTenantSlug()) {
    return jsonRpcError(403, -32001, "This tenant is not served by the MCP upstream.");
  }
  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const token = mcpUpstreamToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  // The gateway has authenticated the tenant; the upstream trusts this header
  // once it serves more than one graph (see docs/FUTURE_STATE.md).
  headers.set("x-code-graph-tenant", tenant.slug);

  let upstream: Response;
  try {
    upstream = await fetch(mcpUpstreamUrl(), {
      method: req.method,
      headers,
      body: req.method === "POST" ? await req.text() : undefined,
      cache: "no-store",
      signal: req.signal,
    });
  } catch (err) {
    console.error("MCP upstream unreachable:", err);
    return jsonRpcError(502, -32603, "MCP upstream unreachable.");
  }
  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

async function handle(req: Request): Promise<Response> {
  let tenant: Tenant | null;
  try {
    tenant = await authenticate(req);
  } catch (err) {
    console.error(err);
    return jsonRpcError(500, -32603, "Internal error.");
  }
  if (!tenant) {
    return jsonRpcError(401, -32001, "Unauthorized: a valid bearer token is required.", {
      "WWW-Authenticate": 'Bearer realm="code-graph"',
    });
  }
  try {
    return mcpBackend() === "proxy" ? await proxy(req, tenant) : await native(req, tenant);
  } catch (err) {
    console.error(err);
    return jsonRpcError(500, -32603, "Internal error.");
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
