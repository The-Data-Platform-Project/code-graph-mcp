import { NextRequest, NextResponse } from "next/server";
import { mcpGet } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const repo = (request.nextUrl.searchParams.get("repo") ?? "").trim();
  if (!repo) {
    return NextResponse.json(
      { found: false, error: "missing 'repo' parameter" },
      { status: 400 },
    );
  }
  const { status, body } = await mcpGet("/api/readme", { repo });
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
