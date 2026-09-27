/**
 * Who is looking, and which tenant's graph they may see.
 *
 * This is the one seam between authentication and everything else. Today it
 * reads the owner-login cookie. When sign-in with Google/GitHub lands, only
 * this function changes: it will read the Supabase Auth session and look the
 * user's tenant and role up in the control plane. Route handlers call
 * getViewer() and use viewer.tenant.schema — they never look at cookies.
 */
import { cookies } from "next/headers";
import { tenantBySlug } from "./control";
import { sessionSecret } from "./env";
import { SESSION_COOKIE, verifySession, type Role } from "./session";
import type { Tenant } from "./tenancy";

export type Viewer = {
  sub: string;
  role: Role;
  tenant: Tenant;
};

export async function getViewer(): Promise<Viewer | null> {
  const jar = await cookies();
  const session = await verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret());
  if (!session) return null;
  const tenant = await tenantBySlug(session.tenant);
  if (!tenant) return null;
  return { sub: session.sub, role: session.role, tenant };
}

export class Unauthorized extends Error {}

/** For route handlers: the viewer, or throw (caught by withViewer below). */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new Unauthorized("not signed in");
  return viewer;
}
