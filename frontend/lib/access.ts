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
 */
export function canAdminister(viewer: Viewer): boolean {
  return viewer.isPlatformAdmin;
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
  if (!canAdminister(viewer)) notFound();
  return viewer;
}
