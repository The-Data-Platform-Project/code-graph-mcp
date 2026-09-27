/**
 * Signed session cookies: `<base64url(payload)>.<base64url(HMAC-SHA256)>`.
 *
 * Web Crypto only — no Node APIs — because middleware runs on the Edge runtime
 * and must verify the same cookie the Node route handlers issue.
 *
 * This is the owner-login session, standing in for real sign-in. When Supabase
 * Auth (Google/GitHub) lands, it replaces the issuer; the payload shape — who
 * the viewer is, which tenant, which role — is what the rest of the app reads.
 */

export const SESSION_COOKIE = "cg_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type Role = "owner" | "admin" | "member";

export type SessionPayload = {
  sub: string;          // who: "owner" today, an auth user id later
  tenant: string;       // tenant slug
  role: Role;
  exp: number;          // unix seconds
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = toB64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${toB64url(new Uint8Array(sig))}`;
}

/** The payload if the cookie is authentic and unexpired, otherwise null. */
export async function verifySession(
  token: string | undefined,
  secret: string,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  let ok = false;
  try {
    // crypto.subtle.verify compares in constant time.
    ok = await crypto.subtle.verify(
      "HMAC", await hmacKey(secret), fromB64url(token.slice(dot + 1)), enc.encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(dec.decode(fromB64url(body))) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    if (typeof payload.tenant !== "string" || typeof payload.sub !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}
