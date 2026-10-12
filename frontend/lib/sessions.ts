/**
 * Server-side sessions (control.sessions).
 *
 * The cookie is httpOnly (no script can read it, so XSS cannot steal it),
 * Secure in production, and SameSite=Strict (never sent on a request another
 * site starts, which closes cross-site request forgery). It carries a signed
 * payload naming a random 256-bit session id; only that id's SHA-256 is
 * stored. Every request re-reads the row, so a session ends the moment it is
 * revoked, not when the cookie expires.
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import { sessionSecret } from "./env";
import { query } from "./pool";
import {
  PENDING_TTL_SECONDS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  type MfaState,
  type Role,
  type SessionPayload,
} from "./session";

export type SessionRow = {
  sub: string;
  user_id: string | null;
  tenant_slug: string;
  role: Role;
  mfa_state: MfaState;
};

/** Stable, non-reversible key for a session (rate-limit keys, the stored id). */
export function idHash(sid: string): string {
  return createHash("sha256").update(sid, "utf8").digest("hex");
}

export type NewSession = {
  sub: string;
  userId: number | null;
  tenant: string;
  role: Role;
  mfa: MfaState;
};

/** Create a session row and return the signed cookie value and its lifetime. */
export async function createSession(
  s: NewSession,
  meta: { ipHash: string | null; userAgent: string | null },
): Promise<{ token: string; maxAge: number }> {
  const sid = randomBytes(32).toString("base64url");
  const maxAge = s.mfa === "pending" ? PENDING_TTL_SECONDS : SESSION_TTL_SECONDS;
  await query(
    `INSERT INTO control.sessions
            (id_hash, sub, user_id, tenant_slug, role, mfa_state, expires_at, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8, $9)`,
    [idHash(sid), s.sub, s.userId, s.tenant, s.role, s.mfa, maxAge, meta.ipHash,
     meta.userAgent?.slice(0, 200) ?? null],
  );
  const payload: SessionPayload = {
    sid, sub: s.sub, tenant: s.tenant, role: s.role, mfa: s.mfa,
    exp: Math.floor(Date.now() / 1000) + maxAge,
  };
  return { token: await signSession(payload, sessionSecret()), maxAge };
}

/** The live session for a cookie's sid, or null if revoked, expired or unknown. */
export async function loadSession(sid: string): Promise<SessionRow | null> {
  const rows = await query<SessionRow & { stale: boolean }>(
    `SELECT sub, user_id, tenant_slug, role, mfa_state,
            last_seen_at < now() - interval '5 minutes' AS stale
       FROM control.sessions
      WHERE id_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [idHash(sid)],
  );
  if (!rows[0]) return null;
  if (rows[0].stale) {
    void query(`UPDATE control.sessions SET last_seen_at = now() WHERE id_hash = $1`, [idHash(sid)])
      .catch(() => {});
  }
  return rows[0];
}

export async function revokeSession(sid: string): Promise<void> {
  await query(
    `UPDATE control.sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash(sid)],
  );
}

/** "Sign out everywhere": every session of `sub` except, optionally, one. */
export async function revokeAllSessions(sub: string, exceptSid?: string): Promise<number> {
  const rows = await query<{ id_hash: string }>(
    `UPDATE control.sessions SET revoked_at = now()
      WHERE sub = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR id_hash <> $2)
      RETURNING id_hash`,
    [sub, exceptSid ? idHash(exceptSid) : null],
  );
  return rows.length;
}

export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};

export function setSessionCookie(res: NextResponse, token: string, maxAge: number): void {
  res.cookies.set(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
}
