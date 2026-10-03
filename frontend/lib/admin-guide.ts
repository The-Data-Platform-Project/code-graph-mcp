import "server-only";
import guide from "@/content/admin/guide.md";

/**
 * The admin guide's Markdown. `server-only` makes the build fail if anything
 * running in the browser ever imports this module, so the guide can only be
 * rendered by the server — and the only page that renders it checks, per
 * request, that the viewer may administer (lib/access.ts).
 */
export const ADMIN_GUIDE_MD: string = guide;
