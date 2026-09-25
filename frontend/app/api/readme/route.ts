import { NextRequest } from "next/server";
import { json, withViewer } from "@/lib/handler";
import { readReadme } from "@/lib/source";

export const dynamic = "force-dynamic";

export const GET = withViewer(async (viewer, request: NextRequest) => {
  const repo = (request.nextUrl.searchParams.get("repo") ?? "").trim();
  if (!repo) return json({ found: false, error: "missing 'repo' parameter" }, 400);
  const result = await readReadme(viewer.tenant, repo);
  return json(result, result.found ? 200 : 404);
});
