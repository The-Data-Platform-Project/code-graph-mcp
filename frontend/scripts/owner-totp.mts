/**
 * Create the owner login's authenticator secret (OWNER_TOTP_SECRET).
 *
 *   node --experimental-strip-types scripts/owner-totp.mts
 *
 * Prints a new 160-bit secret, a QR code to scan with an authenticator app,
 * and the current code so you can check the app agrees. Put the secret in the
 * deployment's environment (Vercel: Settings → Environment Variables) and
 * nowhere else. Run it again to replace a lost device.
 */
import QRCode from "qrcode";
import { base32Decode, currentStep, hotp, newTotpSecret, otpauthUri } from "../lib/totp.ts";

const secret = newTotpSecret();
const uri = otpauthUri(secret, "owner");
console.log(await QRCode.toString(uri, { type: "terminal", small: true }));
console.log(`  OWNER_TOTP_SECRET=${secret}\n`);
console.log(`  Manual entry key: ${secret.match(/.{1,4}/g)?.join(" ")}`);
console.log(`  Code right now:   ${hotp(base32Decode(secret), currentStep())} (should match your app)\n`);
