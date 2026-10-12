/**
 * Shared by the /api/settings routes: who may change a tenant, and the shape
 * rules every user-supplied name must pass before it reaches SQL or a URL.
 */
import "server-only";
import { canManageTenant } from "./access";
import { json } from "./handler";
import type { Viewer } from "./viewer";

/** A graph repo name: what the indexer stores it under (server.py _NAME_RE). */
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** owner/name on GitHub; same rule as the CHECK on repo_connections. */
export const EXTERNAL_REPO_RE = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
/** A branch name, conservatively: no "..", no leading "/" or "-". */
export const BRANCH_RE = /^(?![-/])(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** A 403 response if the viewer may not change this tenant's settings, else null. */
export function forbidUnlessManager(viewer: Viewer): Response | null {
  return canManageTenant(viewer) ? null : json({ error: "only the tenant's owner can change this" }, 403);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function positiveId(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
