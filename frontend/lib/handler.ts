/**
 * Route-handler wrapper: resolve the viewer, then run the handler against their
 * tenant. Every graph route goes through here, so none of them can forget to
 * check who is asking or reach for a tenant other than the viewer's.
 */
import { NextResponse } from "next/server";
import { canAdminister } from "./access";
import { Unauthorized, requireViewer, type Viewer } from "./viewer";

const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function withViewer<A extends unknown[]>(
  handler: (viewer: Viewer, ...args: A) => Promise<Response>,
) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(await requireViewer(), ...args);
    } catch (err) {
      if (err instanceof Unauthorized) return json({ error: "not signed in" }, 401);
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
  };
}

/**
 * For every /api/admin/** route: the viewer must be a platform admin whose
 * session passed 2FA (lib/access.ts canAdminister). Anyone else gets a 404,
 * so the route does not confirm it exists. Authorization lives here, on the
 * server; what the browser shows or hides is never trusted.
 */
export function withAdmin<A extends unknown[]>(
  handler: (viewer: Viewer, ...args: A) => Promise<Response>,
) {
  return withViewer<A>(async (viewer, ...args) => {
    if (!canAdminister(viewer)) return json({ error: "not found" }, 404);
    return handler(viewer, ...args);
  });
}
