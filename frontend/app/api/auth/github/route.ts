import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { githubOAuth, publicAppUrl } from "@/lib/env";
import { OAUTH_COOKIE, safeTarget, seeOther } from "@/lib/signin";

export const dynamic = "force-dynamic";

/**
 * Start "Continue with GitHub": send the browser to GitHub's consent screen.
 *
 * The only permission asked for is identity (`read:user user:email`). GitHub
 * shows it on the consent screen; nothing here can read a repository. Access
 * to code comes later, from fine-grained tokens the person creates for exactly
 * the repositories they choose (/settings).
 *
 * `state` is a random value also kept in a short-lived httpOnly cookie, so the
 * callback only accepts a code from a sign-in this browser started.
 */
export function GET(request: NextRequest) {
  const oauth = githubOAuth();
  if (!oauth) return seeOther("/login?error=config");

  const state = randomBytes(24).toString("base64url");
  const next = safeTarget(request.nextUrl.searchParams.get("next"));
  const origin = publicAppUrl() || request.nextUrl.origin;
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: `${origin}/api/auth/github/callback`,
    scope: "read:user user:email",
    state,
    allow_signup: "true",
  });
  const res = seeOther(`https://github.com/login/oauth/authorize?${params}`);
  res.cookies.set(OAUTH_COOKIE, JSON.stringify({ state, next }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax, not strict: GitHub's redirect back is a top-level cross-site GET.
    sameSite: "lax",
    path: "/api/auth/github",
    maxAge: 600,
  });
  return res;
}
