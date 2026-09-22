import { NextRequest, NextResponse } from "next/server";
import { connections, findNode } from "@/lib/db";
import { graphSource } from "@/lib/env";
import { mcpGet } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/**
 * One node, everything it is wired to, and its source.
 *
 * The split in one place: structure is a Postgres read, while the file's text
 * has to come from the machine that holds the repository. If the tunnel is
 * down the connections still render — only the source pane degrades.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const qname = (params.get("qname") ?? "").trim();
  const repo = (params.get("repo") ?? "").trim() || undefined;
  if (!qname) {
    return NextResponse.json(
      { found: false, error: "missing 'qname' parameter" },
      { status: 400 },
    );
  }

  // No database reachable: the container answers the whole question, source
  // and connections together.
  if (graphSource() === "mcp") {
    const { status, body } = await mcpGet("/api/node", {
      qname,
      ...(repo ? { repo } : {}),
    });
    return NextResponse.json(body, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const node = await findNode(qname, repo);
  if (!node) {
    return NextResponse.json(
      { found: false, error: `no node named '${qname}'` },
      { status: 404 },
    );
  }

  const [wired, source] = await Promise.all([
    connections(node),
    mcpGet("/api/file", { repo: node.repo, path: node.file_path }),
  ]);

  return NextResponse.json(
    { found: true, node, source: source.body, ...wired },
    { headers: { "Cache-Control": "no-store" } },
  );
}
