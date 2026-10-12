/**
 * Gate the application behind a valid session; leave the public site open.
 *
 * Open on purpose:
 *   /, /product, /roadmap, /faq, /docs/**   the public site and user docs
 *   /site/**                                their images (screenshots)
 *   /sitemap.xml, /robots.txt,
 *   /opengraph-image*, /twitter-image*,
 *   /apple-icon*                            metadata files crawlers fetch
 *   /login, /login/verify, /api/auth/*      so there is a way in (each auth route
 *                                           checks its own session and limits)
 *   /api/health                             reports nothing about any tenant
 *   /api/mcp                                authenticates itself, with a bearer token
 *                                           that also selects the tenant — MCP
 *                                           clients have no cookies
 *
 * Everything else — /graph, /settings, /admin/**, the graph APIs — needs a
 * session. This only proves the cookie is authentic and unexpired; whether the
 * session is still live, which tenant it may read, and whether it may
 * administer are decided per request on the server by getViewer() and
 * lib/access.ts. Three more jobs happen here, before any route runs:
 *
 * 1. Cross-site request forgery: a state-changing API request (anything but
 *    GET/HEAD/OPTIONS) must come from this site's own pages — its Origin (or,
 *    without one, Sec-Fetch-Site) must say so. The SameSite=Strict cookie
 *    already stops browsers sending it cross-site; this is the second lock.
 * 2. A session still owed its 2FA code may reach only /login/verify and the
 *    auth routes.
 * 3. SameSite=Strict means a link from another site (an email, Slack) arrives
 *    without the cookie. Such a navigation gets a one-line page that reloads
 *    the same URL from this origin, which does carry it.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "./lib/session";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameOrigin(request: NextRequest): boolean {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      const publicUrl = process.env.PUBLIC_APP_URL;
      return url.host === host || (!!publicUrl && url.origin === new URL(publicUrl).origin);
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function reloadFromHere(request: NextRequest): NextResponse {
  // Collapse leading slashes and backslashes: "//evil.example" would otherwise
  // be a protocol-relative URL, turning this reload into an open redirect.
  const path = "/" + (request.nextUrl.pathname + request.nextUrl.search).replace(/^[\/\\]+/, "");
  const href = path.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}">` +
      `<title>Loading…</title></head><body><p><a href="${href}">Continue</a></p></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

const OPEN = [
  /^\/$/,
  /^\/(product|roadmap|faq)$/,
  /^\/docs(\/[a-z0-9-]+)?$/,
  /^\/site\//,
  /^\/(sitemap\.xml|robots\.txt)$/,
  /^\/(opengraph-image|twitter-image|apple-icon)[^/]*$/,
  /^\/login(\/verify)?$/,
  /^\/api\/auth\//,
  /^\/api\/health$/,
  /^\/api\/mcp(\/|$)/,
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/") && !pathname.startsWith("/api/mcp")
      && !SAFE_METHODS.has(request.method) && !sameOrigin(request)) {
    return NextResponse.json({ error: "cross-site request refused" }, { status: 403 });
  }

  if (OPEN.some((re) => re.test(pathname))) return NextResponse.next();

  const secret = process.env.SESSION_SECRET ?? "";
  const session = secret.length >= 32
    ? await verifySession(request.cookies.get(SESSION_COOKIE)?.value, secret)
    : null;

  if (session?.mfa === "pending") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "two-factor code required" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login/verify", request.url));
  }
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  if (request.method === "GET" && request.headers.get("sec-fetch-site") === "cross-site"
      && request.headers.get("sec-fetch-mode") === "navigate") {
    return reloadFromHere(request);
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next's own static files and the icons.
  matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico).*)"],
};
