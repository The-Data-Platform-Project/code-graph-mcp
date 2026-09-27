/**
 * Gate every page and graph API behind a valid session.
 *
 * Left open on purpose:
 *   /login, /api/auth/*   so there is a way in
 *   /api/health           reports nothing about any tenant
 *   /api/mcp              authenticates itself, with a bearer token that also
 *                         selects the tenant — Claude Code has no cookies
 *   static assets
 *
 * This only proves the cookie is authentic and unexpired; which tenant it may
 * read is resolved per request by getViewer() in the route handlers.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/session";

const OPEN = [/^\/login$/, /^\/api\/auth\//, /^\/api\/health$/, /^\/api\/mcp(\/|$)/];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (OPEN.some((re) => re.test(pathname))) return NextResponse.next();

  const secret = process.env.SESSION_SECRET ?? "";
  const session = secret.length >= 32
    ? await verifySession(request.cookies.get(SESSION_COOKIE)?.value, secret)
    : null;
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own static files and the favicon.
  matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico).*)"],
};
