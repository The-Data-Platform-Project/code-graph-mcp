import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ownerPassword, ownerTenantSlug, sessionSecret } from "@/lib/env";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DEFAULT_TARGET = "/graph";

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
  // After signing in, the explorer — "/" is the public landing page now.
  const next = String(form?.get("next") ?? DEFAULT_TARGET);
  // Only same-site relative paths, so the login form cannot be used as an
  // open redirect.
  const target = next.startsWith("/") && !next.startsWith("//") ? next : DEFAULT_TARGET;
  const back = (error: string) => {
    const params = new URLSearchParams({ error });
    if (target !== DEFAULT_TARGET) params.set("next", target);
    return seeOther(`/login?${params}`);
  };

  // A deployment without (or with too weak) sign-in settings — a preview
  // without OWNER_PASSWORD, say — must answer with a page, not a 500. The
  // reason goes to the server log; the visitor only learns sign-in is off.
  let expected: string;
  let secret: string;
  try {
    expected = ownerPassword();
    secret = sessionSecret();
  } catch (err) {
    console.error("sign-in is not configured:", err instanceof Error ? err.message : err);
    return back("config");
  }

  if (!password || !sameSecret(password, expected)) {
    // A fixed delay makes guessing slow without keeping any state.
    await new Promise((r) => setTimeout(r, 600));
    return back("1");
  }

  const token = await signSession(
    {
      sub: "owner",
      tenant: ownerTenantSlug(),
      role: "owner",
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    },
    secret,
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
