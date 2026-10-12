/**
 * TOTP (RFC 6238) over HOTP (RFC 4226), SHA-1, 6 digits, 30-second steps:
 * what every authenticator app (Google Authenticator, 1Password, Authy...)
 * expects. Pure functions on node:crypto; no dependencies, no state. Replay
 * protection (a code is accepted once) lives in lib/mfa.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (the length RFC 4226 recommends). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(key: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/**
 * The time step `code` belongs to, within ±`window` steps of now, or null.
 * The caller must refuse a step at or before the last one it accepted.
 */
export function matchTotp(
  secretB32: string,
  code: string,
  opts: { nowMs?: number; window?: number } = {},
): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const key = base32Decode(secretB32);
  const now = currentStep(opts.nowMs);
  const window = opts.window ?? 1;
  let found: number | null = null;
  // Check every candidate (no early exit) so timing does not reveal which matched.
  for (let step = now - window; step <= now + window; step++) {
    const expected = Buffer.from(hotp(key, step));
    if (timingSafeEqual(expected, Buffer.from(digits)) && found === null) found = step;
  }
  return found;
}

export function otpauthUri(secretB32: string, account: string, issuer = "ContextForge"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}
