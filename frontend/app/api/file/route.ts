import { NextRequest, NextResponse } from "next/server";
import { mcpGet } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const repo = (params.get("repo") ?? "").trim();
  const path = (params.get("path") ?? "").trim();
  if (!repo || !path) {
    return NextResponse.json(
      { found: false, error: "both 'repo' and 'path' are required" },
      { status: 400 },
    );
  }
  // Path confinement is enforced by the service itself (safe_join against the
  // repo root), so this proxy deliberately adds no rules of its own.
  const { status, body } = await mcpGet("/api/file", { repo, path });
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
