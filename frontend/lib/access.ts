import "server-only";
import { notFound, redirect } from "next/navigation";
import { getViewer, type Viewer } from "./viewer";

/**
 * Who may read administrative pages and approve sign-ups.
 *
 * Platform administration is its own flag (control.users.is_platform_admin),
 * separate from tenant roles: every approved user owns their own tenant, and
 * that must not make them an administrator of the platform. The owner password
 * login is a platform admin.
 *
 * Admin powers also require that THIS session passed a second factor: a
 * platform admin signed in without 2FA (not yet enrolled) is an ordinary user
 * until they enrol and verify. Every admin page and admin API route calls
 * this on the server; the browser is only ever told whether to show a link.
 */
export function canAdminister(viewer: Viewer): boolean {
  return viewer.isPlatformAdmin && viewer.mfaVerified;
}

/** A platform admin who still has to set up 2FA before admin powers unlock. */
export function adminNeedsMfa(viewer: Viewer): boolean {
  return viewer.isPlatformAdmin && !viewer.mfaVerified;
}

/** Who may change a tenant's GitHub tokens and repo connections. */
export function canManageTenant(viewer: Viewer): boolean {
  return viewer.role === "owner" || viewer.role === "admin";
}

/**
 * For admin pages: the viewer, or never return.
 *
 * Signed out → the sign-in page, which brings them back. Signed in without
 * admin rights → a 404, so the page does not confirm it exists.
 * middleware.ts has already refused requests without a valid session; this is
 * the authorization check, and it runs on every request.
 */
export async function requireAdmin(returnTo: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  if (adminNeedsMfa(viewer)) redirect("/settings?mfa=required#security");
  if (!canAdminister(viewer)) notFound();
  return viewer;
}
