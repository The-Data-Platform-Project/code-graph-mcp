import { cookies } from "next/headers";
import { logAuthEvent } from "@/lib/authlog";
import { sessionSecret } from "@/lib/env";
import { SESSION_COOKIE, verifySession } from "@/lib/session";
import { clearSessionCookie, revokeSession } from "@/lib/sessions";
import { requestMeta, seeOther } from "@/lib/signin";

export const dynamic = "force-dynamic";

/** Sign out: end the session on the server, not just in this browser. */
export async function POST(request: Request) {
  const jar = await cookies();
  const payload = await verifySession(jar.get(SESSION_COOKIE)?.value, sessionSecret()).catch(() => null);
  if (payload) {
    await revokeSession(payload.sid);
    await logAuthEvent("sign_out", "info", payload.sub, requestMeta(request).ipHash);
  }
  // Relative Location: stay on the host the browser used.
  const res = seeOther("/login");
  clearSessionCookie(res);
  return res;
}
