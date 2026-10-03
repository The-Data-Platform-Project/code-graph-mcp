/**
 * Gate the application behind a valid session; leave the public site open.
 *
 * Open on purpose:
 *   /, /product, /roadmap, /faq, /docs/**   the public site and user docs
 *   /site/**                                their images (screenshots)
 *   /sitemap.xml, /robots.txt,
 *   /opengraph-image*, /twitter-image*,
 *   /apple-icon*                            metadata files crawlers fetch
 *   /login, /api/auth/*                     so there is a way in
 *   /api/health                             reports nothing about any tenant
 *   /api/mcp                                authenticates itself, with a bearer token
 *                                           that also selects the tenant — MCP
 *                                           clients have no cookies
 *
 * Everything else — /graph, /admin/**, the graph APIs — needs a session. This
 * only proves the cookie is authentic and unexpired; which tenant it may read,
 * and whether it may administer, is decided per request by getViewer() and
 * lib/access.ts in the pages and route handlers.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/session";

const OPEN = [
  /^\/$/,
  /^\/(product|roadmap|faq)$/,
  /^\/docs(\/[a-z0-9-]+)?$/,
  /^\/site\//,
  /^\/(sitemap\.xml|robots\.txt)$/,
  /^\/(opengraph-image|twitter-image|apple-icon)[^/]*$/,
  /^\/login$/,
  /^\/api\/auth\//,
  /^\/api\/health$/,
  /^\/api\/mcp(\/|$)/,
];

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
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own static files and the icons.
  matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico).*)"],
};
