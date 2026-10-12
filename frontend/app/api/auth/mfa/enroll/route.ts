import QRCode from "qrcode";
import { json, withViewer } from "@/lib/handler";
import { startEnrollment } from "@/lib/mfa";
import { mfaGate } from "@/lib/mfaroute";

export const dynamic = "force-dynamic";

/**
 * Begin setting up an authenticator app: a new secret (not active until a
 * first code confirms it), as a QR code and as text for manual entry. The
 * secret is shown only now; it is stored sealed.
 */
export const POST = withViewer(async (viewer, request: Request) => {
  if (viewer.userId === null) return json({ error: "The owner login's 2FA is set in OWNER_TOTP_SECRET." }, 400);
  const gate = await mfaGate(request, viewer, "mfa_enroll");
  if (gate) return gate;
  const started = await startEnrollment(viewer.userId, viewer.githubLogin ?? viewer.sub);
  if (!started) return json({ error: "2FA is already on. Turn it off first to change apps." }, 409);
  const qrSvg = await QRCode.toString(started.uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return json({ secret: started.secret, uri: started.uri, qrSvg });
});
