import "server-only";
import { notFound, redirect } from "next/navigation";
import { getViewer, type Viewer } from "./viewer";

/**
 * Who may read administrative pages.
 *
 * Today there is one account, the owner, so administration is the owner role.
 * When sign-in with Google/GitHub lands, platform-admin rights become their
 * own flag (control.users.is_platform_admin in docs/FUTURE_STATE.md); this is
 * the one function that changes, and every admin page already calls it.
 */
export function canAdminister(viewer: Viewer): boolean {
  return viewer.role === "owner";
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
