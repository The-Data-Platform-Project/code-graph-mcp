/**
 * Who is looking, and which tenant's graph they may see.
 *
 * This is the one seam between authentication and everything else. The
 * session cookie (lib/session.ts) names a server-side session (lib/sessions.ts):
 *
 *   sub "owner"      the owner password login (break-glass; password + TOTP)
 *   sub "user:<id>"  a GitHub sign-in, a row in control.users
 *
 * The session row, not the cookie, is the authority: it is re-read on every
 * request, so signing out, "sign out everywhere" and suspension take effect at
 * once. A session still owed its 2FA code ("pending") is not a viewer at all.
 * A GitHub user's status and membership are re-read too. Route handlers call
 * getViewer() and use viewer.tenant — they never look at cookies.
 */
import { cookies } from "next/headers";
import { userAccess } from "./accounts";
import { tenantBySlug } from "./control";
import { sessionSecret } from "./env";
import { SESSION_COOKIE, verifySession, type Role, type SessionPayload } from "./session";
import { loadSession, type SessionRow } from "./sessions";
import type { Tenant } from "./tenancy";

export type Viewer = {
  sub: string;
  sid: string;
  role: Role;
  tenant: Tenant;
  /** control.users.id; null for the owner password login. */
  userId: number | null;
  githubLogin: string | null;
  /** Holds the platform-admin flag. Admin powers also need mfaVerified (lib/access.ts). */
  isPlatformAdmin: boolean;
  /** This session passed a second factor. */
  mfaVerified: boolean;
};

const USER_SUB = /^user:(\d{1,18})$/;

async function currentSession(): Promise<{ payload: SessionPayload; row: SessionRow } | null> {
  const jar = await cookies();
  const payload = await verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  if (!payload) return null;
  const row = await loadSession(payload.sid);
  if (!row || row.sub !== payload.sub) return null;
  return { payload, row };
}

export async function getViewer(): Promise<Viewer | null> {
  const current = await currentSession();
  if (!current || current.row.mfa_state === "pending") return null;
  const { payload, row } = current;
  const tenant = await tenantBySlug(row.tenant_slug);
  if (!tenant) return null;
  const mfaVerified = row.mfa_state === "verified";

  if (row.sub === "owner") {
    return {
      sub: row.sub, sid: payload.sid, role: row.role, tenant,
      userId: null, githubLogin: null,
      isPlatformAdmin: row.role === "owner", mfaVerified,
    };
  }
  const match = USER_SUB.exec(row.sub);
  if (!match) return null;
  const userId = Number(match[1]);
  const access = await userAccess(userId, tenant.id);
  if (!access) return null;
  return {
    sub: row.sub, sid: payload.sid, role: access.role, tenant,
    userId, githubLogin: access.login,
    isPlatformAdmin: access.isPlatformAdmin, mfaVerified,
  };
}

/** A sign-in that has passed its first factor and still owes a 2FA code. */
export async function getPendingSession(): Promise<{ sid: string; row: SessionRow } | null> {
  const current = await currentSession();
  if (!current || current.row.mfa_state !== "pending") return null;
  return { sid: current.payload.sid, row: current.row };
}

export class Unauthorized extends Error {}

/** For route handlers: the viewer, or throw (caught by withViewer below). */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new Unauthorized("not signed in");
  return viewer;
}
