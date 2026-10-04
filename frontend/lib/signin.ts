/**
 * What both sign-in routes share: a safe post-login target and the session
 * cookie. Redirects use a relative Location so the browser stays on the host
 * it used rather than the one Next was configured with.
 */
import "server-only";
import { NextResponse } from "next/server";
import { sessionSecret } from "./env";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, type Role } from "./session";

export const DEFAULT_TARGET = "/graph";

/** Holds the OAuth `state` and post-login target between the two GitHub hops. */
export const OAUTH_COOKIE = "cg_oauth";

/** Only same-site relative paths, so sign-in cannot be used as an open redirect. */
export function safeTarget(next: string | null | undefined): string {
  const value = next ?? "";
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : DEFAULT_TARGET;
}

export function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

export async function signedIn(
  target: string,
  who: { sub: string; tenant: string; role: Role },
): Promise<NextResponse> {
  const token = await signSession(
    { ...who, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
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
