import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { logAuthEvent } from "@/lib/authlog";
import { OAUTH_PER_IP } from "@/lib/authpolicy";
import { githubOAuth, publicAppUrl } from "@/lib/env";
import { consume } from "@/lib/ratelimit";
import { OAUTH_COOKIE, requestMeta, safeTarget, seeOther } from "@/lib/signin";

export const dynamic = "force-dynamic";

/**
 * Start "Continue with GitHub" (sign-in and sign-up are the same flow): send
 * the browser to GitHub's consent screen.
 *
 * The only permission asked for is identity (`read:user user:email`). GitHub
 * shows it on the consent screen; nothing here can read a repository. Access
 * to code comes later, from fine-grained tokens the person creates for exactly
 * the repositories they choose (/settings).
 *
 * `state` is a random value also kept in a short-lived httpOnly cookie, so the
 * callback only accepts a code from a sign-in this browser started. That
 * cookie is SameSite=Lax on purpose: it has to come back on GitHub's
 * cross-site redirect. Rate limited per IP (10 per 15 minutes).
 */
export async function GET(request: NextRequest) {
  const oauth = githubOAuth();
  if (!oauth) return seeOther("/login?error=config");

  const meta = requestMeta(request);
  const rate = await consume(`oauth-start:ip:${meta.ipHash}`, OAUTH_PER_IP);
  if (!rate.allowed) {
    await logAuthEvent("github_start", "blocked", null, meta.ipHash, { reason: "rate_limit" });
    return seeOther(`/login?error=rate&retry=${rate.retryAfterSec}`);
  }

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
    sameSite: "lax",
    path: "/api/auth/github",
    maxAge: 600,
  });
  return res;
}
