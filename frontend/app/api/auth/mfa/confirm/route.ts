import { json, withViewer } from "@/lib/handler";
import { confirmEnrollment } from "@/lib/mfa";
import { mfaFailed, mfaGate, mfaSucceeded, swapSession } from "@/lib/mfaroute";
import { readJson } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Finish setup with a first code from the app. Turns 2FA on, returns the ten
 * backup codes (shown once), and upgrades this session to "verified": the
 * user has just proved the second factor. That is also what unlocks admin
 * powers for a platform admin.
 */
export const POST = withViewer(async (viewer, request: Request) => {
  if (viewer.userId === null) return json({ error: "Not available for the owner login." }, 400);
  const gate = await mfaGate(request, viewer, "mfa_confirm");
  if (gate) return gate;
  const { code } = await readJson(request);
  const codes = await confirmEnrollment(viewer.userId, String(code ?? "").slice(0, 32));
  if (!codes) return mfaFailed(request, viewer, "mfa_confirm");
  await mfaSucceeded(request, viewer, "mfa_confirm");
  return swapSession(request, viewer, "verified", json({ backupCodes: codes }));
});
