import { logAuthEvent } from "@/lib/authlog";
import { json, withViewer } from "@/lib/handler";
import { revokeAllSessions } from "@/lib/sessions";
import { requestMeta } from "@/lib/signin";

export const dynamic = "force-dynamic";

/** "Sign out everywhere else": revoke every other session of this account. */
export const DELETE = withViewer(async (viewer, request: Request) => {
  const count = await revokeAllSessions(viewer.sub, viewer.sid);
  await logAuthEvent("sign_out_others", "info", viewer.sub, requestMeta(request).ipHash, { sessions: count });
  return json({ revoked: count });
});
