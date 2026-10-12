/**
 * Who is asking (a hashed IP) and the append-only record of what happened:
 * every failed sign-in, 2FA code, lockout and CAPTCHA refusal is written to
 * control.auth_events, which the app's database role can insert into but
 * never change or delete.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { sessionSecret } from "./env";
import { query } from "./pool";

/**
 * The client's IP. On Vercel the platform overwrites x-forwarded-for with the
 * real client address, so its first entry can be trusted there; locally the
 * app listens on 127.0.0.1 only.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

/** IPs are personal data: keep a keyed hash, enough to count and correlate. */
export function ipHash(ip: string): string {
  return createHmac("sha256", sessionSecret()).update(`ip:${ip}`).digest("hex").slice(0, 32);
}

export type AuthOutcome = "success" | "failure" | "blocked" | "info";

export async function logAuthEvent(
  kind: string,
  outcome: AuthOutcome,
  subject: string | null,
  ip: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await query(
      `INSERT INTO control.auth_events (kind, outcome, subject, ip_hash, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [kind, outcome, subject, ip, JSON.stringify(detail)],
    );
  } catch (err) {
    // Never let logging break sign-in, but never lose the event silently either.
    console.error("auth event not recorded:", kind, outcome, err instanceof Error ? err.message : err);
  }
}
