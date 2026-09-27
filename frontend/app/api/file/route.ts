import { NextRequest } from "next/server";
import { json, withViewer } from "@/lib/handler";
import { readFile } from "@/lib/source";

export const dynamic = "force-dynamic";

export const GET = withViewer(async (viewer, request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const repo = (params.get("repo") ?? "").trim();
  const path = (params.get("path") ?? "").trim();
  if (!repo || !path) return json({ found: false, error: "both 'repo' and 'path' are required" }, 400);
  const result = await readFile(viewer.tenant, repo, path);
  return json(result, result.found ? 200 : 404);
});
