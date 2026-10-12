/**
 * Shared by the 2FA management routes: rate limits and lockout around any
 * endpoint that checks a code, and the session swap after a code is proven.
 */
import "server-only";
import { NextResponse } from "next/server";
import { logAuthEvent } from "./authlog";
import { MFA_FAILURES, MFA_PER_IP, MFA_PER_SESSION } from "./authpolicy";
import { json } from "./handler";
import { clearFailures, consume, failureState, recordFailure } from "./ratelimit";
import { idHash, revokeSession } from "./sessions";
import { requestMeta, startSession } from "./signin";
import type { Viewer } from "./viewer";

/** Refuse with 429 if this IP, session or account is over its limits. */
export async function mfaGate(request: Request, viewer: Viewer, kind: string): Promise<Response | null> {
  const meta = requestMeta(request);
  for (const [key, window] of [
    [`mfa:ip:${meta.ipHash}`, MFA_PER_IP],
    [`mfa:sess:${idHash(viewer.sid)}`, MFA_PER_SESSION],
  ] as const) {
    const rate = await consume(key, window);
    if (!rate.allowed) {
      await logAuthEvent(kind, "blocked", viewer.sub, meta.ipHash, { reason: "rate_limit" });
      return json({ error: "Too many attempts. Try again later.", retryAfter: rate.retryAfterSec }, 429);
    }
  }
  const lock = await failureState(`mfa:subj:${viewer.sub}`);
  if (lock.lockedForSec > 0) {
    await logAuthEvent(kind, "blocked", viewer.sub, meta.ipHash, { reason: "locked" });
    return json({ error: "2FA is locked after repeated wrong codes. Try again later.", retryAfter: lock.lockedForSec }, 429);
  }
  return null;
}

export async function mfaFailed(request: Request, viewer: Viewer, kind: string): Promise<Response> {
  const meta = requestMeta(request);
  const state = await recordFailure(`mfa:subj:${viewer.sub}`, MFA_FAILURES);
  await logAuthEvent(kind, "failure", viewer.sub, meta.ipHash, { failures: state.failures });
  return state.lockedForSec > 0
    ? json({ error: "Too many wrong codes. 2FA is locked for a while.", retryAfter: state.lockedForSec }, 429)
    : json({ error: "That code is not right." }, 400);
}

export async function mfaSucceeded(request: Request, viewer: Viewer, kind: string, detail = {}): Promise<void> {
  await clearFailures(`mfa:subj:${viewer.sub}`);
  await logAuthEvent(kind, "success", viewer.sub, requestMeta(request).ipHash, detail);
}

/** Replace the current session with one at the new 2FA state (new id). */
export async function swapSession(
  request: Request,
  viewer: Viewer,
  mfa: "none" | "verified",
  res: NextResponse,
): Promise<NextResponse> {
  await revokeSession(viewer.sid);
  return startSession(
    request,
    { sub: viewer.sub, userId: viewer.userId, tenant: viewer.tenant.slug, role: viewer.role, mfa },
    res,
  );
}
