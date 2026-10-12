/**
 * What the sign-in routes share: a safe post-login target, the session
 * response, and the request metadata recorded with each session.
 */
import "server-only";
import { NextResponse } from "next/server";
import { clientIp, ipHash } from "./authlog";
import { DEFAULT_TARGET, safeTarget } from "./redirect";
import { createSession, setSessionCookie, type NewSession } from "./sessions";

export { DEFAULT_TARGET, safeTarget };

/** Holds the OAuth `state` and post-login target between the two GitHub hops. */
export const OAUTH_COOKIE = "cg_oauth";

/** A relative Location, so the browser stays on the host it used. */
export function seeOther(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * A page that moves the browser on to `target` from our own origin.
 *
 * The session cookie is SameSite=Strict, so it is not sent on a navigation
 * another site started, including the rest of a redirect chain that began at
 * github.com. Answering GitHub's callback with this page instead of a 303 makes
 * the next navigation same-site, so the new session is sent with it.
 */
export function bouncePage(target: string): NextResponse {
  const href = escapeHtml(safeTarget(target));
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
      `<meta http-equiv="refresh" content="0;url=${href}"><title>Signing in…</title></head>` +
      `<body><p><a href="${href}">Continue</a></p></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export function requestMeta(request: Request): { ip: string; ipHash: string; userAgent: string | null } {
  const ip = clientIp(request.headers);
  return { ip, ipHash: ipHash(ip), userAgent: request.headers.get("user-agent") };
}

/** Create a session and put its cookie on `res`. */
export async function startSession(request: Request, s: NewSession, res: NextResponse): Promise<NextResponse> {
  const meta = requestMeta(request);
  const { token, maxAge } = await createSession(s, { ipHash: meta.ipHash, userAgent: meta.userAgent });
  setSessionCookie(res, token, maxAge);
  return res;
}
