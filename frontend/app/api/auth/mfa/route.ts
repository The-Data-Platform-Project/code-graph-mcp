import { json, withViewer } from "@/lib/handler";
import { mfaStatus } from "@/lib/mfa";

export const dynamic = "force-dynamic";

/** This user's 2FA state. Required for platform admins. */
export const GET = withViewer(async (viewer) => {
  if (viewer.userId === null) {
    // The owner password login's 2FA is OWNER_TOTP_SECRET, managed in the environment.
    return json({ managedByEnvironment: true, enabled: true, required: true, sessionVerified: viewer.mfaVerified });
  }
  const status = await mfaStatus(viewer.userId);
  return json({ ...status, required: viewer.isPlatformAdmin, sessionVerified: viewer.mfaVerified });
});
