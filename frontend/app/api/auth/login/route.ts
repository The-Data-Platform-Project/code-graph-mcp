import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ownerPassword, ownerTenantSlug, sessionSecret } from "@/lib/env";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function sameSecret(a: string, b: string): boolean {
  // Hash first so the comparison is over equal-length buffers and runs in
  // constant time regardless of how long the guess is.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * A relative Location, so the redirect stays on whatever host the browser used
 * rather than the one Next was configured with.
 */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

/**
 * Owner login: one shared password, standing in for real sign-in until
 * Supabase Auth (Google/GitHub) replaces this route.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const password = String(form?.get("password") ?? "");
  const next = String(form?.get("next") ?? "/");
  // Only same-site relative paths, so the login form cannot be used as an
  // open redirect.
  const target = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  if (!password || !sameSecret(password, ownerPassword())) {
    // A fixed delay makes guessing slow without keeping any state.
    await new Promise((r) => setTimeout(r, 600));
    const back = new URLSearchParams({ error: "1" });
    if (target !== "/") back.set("next", target);
    return seeOther(`/login?${back}`);
  }

  const token = await signSession(
    {
      sub: "owner",
      tenant: ownerTenantSlug(),
      role: "owner",
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    sessionSecret(),
  );
  const res = seeOther(target);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
