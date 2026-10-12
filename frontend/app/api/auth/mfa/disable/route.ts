import { json, withViewer } from "@/lib/handler";
import { disableMfa, verifyUserCode } from "@/lib/mfa";
import { mfaFailed, mfaGate, mfaSucceeded, swapSession } from "@/lib/mfaroute";
import { revokeAllSessions } from "@/lib/sessions";
import { readJson } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Turn 2FA off, which takes a current code. Platform admins cannot: 2FA is
 * mandatory for them. Every other session of this user is signed out.
 */
export const POST = withViewer(async (viewer, request: Request) => {
  if (viewer.userId === null) return json({ error: "Not available for the owner login." }, 400);
  if (viewer.isPlatformAdmin) return json({ error: "Administrators must keep 2FA on." }, 403);
  const gate = await mfaGate(request, viewer, "mfa_disable");
  if (gate) return gate;
  const { code } = await readJson(request);
  if (!(await verifyUserCode(viewer.userId, String(code ?? "").slice(0, 32)))) {
    return mfaFailed(request, viewer, "mfa_disable");
  }
  await disableMfa(viewer.userId);
  await revokeAllSessions(viewer.sub, viewer.sid);
  await mfaSucceeded(request, viewer, "mfa_disable");
  return swapSession(request, viewer, "none", json({ ok: true }));
});
