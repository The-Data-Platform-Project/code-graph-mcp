/**
 * Encryption at rest for GitHub tokens, which the app must read back to call
 * GitHub (so they cannot be hashed like MCP tokens).
 *
 * AES-256-GCM under GITHUB_TOKEN_KEY (64 hex chars). Wire format, shared
 * byte-for-byte with src/code_graph/secretbox.py so the indexer can open what
 * the app sealed:
 *
 *     v1.<base64url 12-byte nonce>.<base64url ciphertext || 16-byte tag>
 *
 * The additional authenticated data names the owning tenant, so a ciphertext
 * copied onto another tenant's row fails to open.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function parseKey(hex: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(hex.trim()) ? Buffer.from(hex.trim(), "hex") : null;
  if (!key) throw new Error("GITHUB_TOKEN_KEY must be 64 hex characters (openssl rand -hex 32)");
  return key;
}

export function tokenAad(tenantId: number): Buffer {
  return Buffer.from(`github_token:${Math.trunc(tenantId)}`, "ascii");
}

export function seal(key: Buffer, plaintext: string, aad: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${nonce.toString("base64url")}.${body.toString("base64url")}`;
}

/** The plaintext; throws if the value is malformed or fails authentication. */
export function openSealed(key: Buffer, sealed: string, aad: Buffer): string {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new Error("not a sealed v1 secret");
  const nonce = Buffer.from(parts[1], "base64url");
  const body = Buffer.from(parts[2], "base64url");
  if (nonce.length !== 12 || body.length < 16) throw new Error("not a sealed v1 secret");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
    .toString("utf8");
}
