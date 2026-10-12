import { json, withViewer } from "@/lib/handler";
import { regenerateBackupCodes, verifyUserCode } from "@/lib/mfa";
import { mfaFailed, mfaGate, mfaSucceeded } from "@/lib/mfaroute";
import { readJson } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Replace all backup codes (the old ones stop working). Takes a current code. */
export const POST = withViewer(async (viewer, request: Request) => {
  if (viewer.userId === null) return json({ error: "Not available for the owner login." }, 400);
  const gate = await mfaGate(request, viewer, "mfa_backup_codes");
  if (gate) return gate;
  const { code } = await readJson(request);
  if (!(await verifyUserCode(viewer.userId, String(code ?? "").slice(0, 32)))) {
    return mfaFailed(request, viewer, "mfa_backup_codes");
  }
  const codes = await regenerateBackupCodes(viewer.userId);
  await mfaSucceeded(request, viewer, "mfa_backup_codes");
  return json({ backupCodes: codes });
});
