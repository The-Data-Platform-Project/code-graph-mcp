import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

export function POST() {
  // Relative Location: stay on the host the browser used.
  const res = new NextResponse(null, { status: 303, headers: { Location: "/login" } });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
