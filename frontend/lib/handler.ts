/**
 * Route-handler wrapper: resolve the viewer, then run the handler against their
 * tenant. Every graph route goes through here, so none of them can forget to
 * check who is asking or reach for a tenant other than the viewer's.
 */
import { NextResponse } from "next/server";
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
