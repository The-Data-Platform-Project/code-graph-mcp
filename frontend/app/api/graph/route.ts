import { NextRequest, NextResponse } from "next/server";
import { graphPayload } from "@/lib/db";
import { graphSource } from "@/lib/env";
import { mcpGet } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get("repo") ?? undefined;

  // Without a reachable database the container can serve the same payload; see
  // graphSource() for when each applies.
  if (graphSource() === "mcp") {
    const { status, body } = await mcpGet("/api/graph", {});
    return NextResponse.json(body, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    return NextResponse.json(await graphPayload(repo || undefined), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "graph query failed" },
      { status: 503 },
    );
  }
}
