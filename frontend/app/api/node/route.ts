import { NextRequest } from "next/server";
import { findNode, nodeConnections } from "@/lib/graph";
import { json, withViewer } from "@/lib/handler";
import { readFile } from "@/lib/source";

export const dynamic = "force-dynamic";

/**
 * One node, everything it is wired to, and its source. Structure is a Postgres
 * read in the viewer's tenant; the text comes from the source provider, so if
 * that is unavailable the connections still render and only the code pane
 * degrades.
 */
export const GET = withViewer(async (viewer, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const qname = (params.get("qname") ?? "").trim();
  const repo = (params.get("repo") ?? "").trim() || undefined;
  if (!qname) return json({ found: false, error: "missing 'qname' parameter" }, 400);

  const schema = viewer.tenant.schema;
  const node = await findNode(schema, qname, repo);
  if (!node) return json({ found: false, error: `no node named '${qname}'` }, 404);

  const [wired, source] = await Promise.all([
    nodeConnections(schema, node),
    readFile(viewer.tenant, node.repo, node.file_path),
  ]);
  return json({ found: true, node, source, ...wired });
});
