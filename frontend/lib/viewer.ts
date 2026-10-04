/**
 * Who is looking, and which tenant's graph they may see.
 *
 * This is the one seam between authentication and everything else. A session
 * cookie (lib/session.ts) names who signed in and which tenant they chose:
 *
 *   sub "owner"      the owner password login (break-glass; OWNER_PASSWORD)
 *   sub "user:<id>"  a GitHub sign-in, a row in control.users
 *
 * A GitHub user's status and membership are re-read here on every request, so
 * suspending someone or removing them from a tenant takes effect at once
 * rather than when their cookie expires. Route handlers call getViewer() and
 * use viewer.tenant — they never look at cookies.
 */
import { cookies } from "next/headers";
import { userAccess } from "./accounts";
import { tenantBySlug } from "./control";
import { sessionSecret } from "./env";
import { SESSION_COOKIE, verifySession, type Role } from "./session";
import type { Tenant } from "./tenancy";

export type Viewer = {
  sub: string;
  role: Role;
  tenant: Tenant;
  /** control.users.id; null for the owner password login. */
  userId: number | null;
  githubLogin: string | null;
  /** May approve sign-ups and read the admin guide (lib/access.ts). */
  isPlatformAdmin: boolean;
};

const USER_SUB = /^user:(\d{1,18})$/;

export async function getViewer(): Promise<Viewer | null> {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  if (!session) return null;
  const tenant = await tenantBySlug(session.tenant);
  if (!tenant) return null;

  if (session.sub === "owner") {
    return {
      sub: session.sub, role: session.role, tenant,
      userId: null, githubLogin: null, isPlatformAdmin: session.role === "owner",
    };
  }
  const match = USER_SUB.exec(session.sub);
  if (!match) return null;
  const userId = Number(match[1]);
  const access = await userAccess(userId, tenant.id);
  if (!access) return null;
  return {
    sub: session.sub, role: access.role, tenant,
    userId, githubLogin: access.login, isPlatformAdmin: access.isPlatformAdmin,
  };
}

export class Unauthorized extends Error {}

/** For route handlers: the viewer, or throw (caught by withViewer below). */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new Unauthorized("not signed in");
  return viewer;
}
