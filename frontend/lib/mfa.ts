/**
 * Two-factor authentication: TOTP authenticator apps plus single-use backup
 * codes. Used by GitHub-signed-in users (secrets in control.user_mfa) and the
 * owner password login (secret in OWNER_TOTP_SECRET).
 *
 * - TOTP secrets are sealed with AES-256-GCM under MFA_ENCRYPTION_KEY, bound
 *   to their user, and only opened on the server.
 * - Each accepted code's time step is recorded per subject (control.mfa_replay);
 *   the same or an earlier step is refused, so a code works once.
 * - Backup codes (10, about 50 bits each) are shown once and stored as salted
 *   scrypt hashes; each one works once.
 * Attempts are rate limited and locked out by the routes that call these.
 */
import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mfaKeyHex, ownerTotpSecret } from "./env";
import { query, transaction } from "./pool";
import { openSealed, parseKey, seal } from "./secretbox";
import { base32Encode, matchTotp, newTotpSecret, otpauthUri } from "./totp";

const BACKUP_CODE_COUNT = 10;

function key(): Buffer {
  return parseKey(mfaKeyHex());
}

function aad(userId: number): Buffer {
  return Buffer.from(`mfa_totp:${Math.trunc(userId)}`, "ascii");
}

/** Accept `step` for `subject` only if it is newer than the last accepted one. */
async function claimStep(subject: string, step: number): Promise<boolean> {
  const rows = await query<{ subject: string }>(
    `INSERT INTO control.mfa_replay AS r (subject, last_step) VALUES ($1, $2)
     ON CONFLICT (subject) DO UPDATE SET last_step = EXCLUDED.last_step
       WHERE r.last_step < EXCLUDED.last_step
     RETURNING subject`,
    [subject, step],
  );
  return rows.length === 1;
}

// ── Backup codes ────────────────────────────────────────────────────────────

function normalizeBackup(code: string): string {
  return code.toLowerCase().replace(/[^a-z2-7]/g, "");
}

function hashBackup(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(normalizeBackup(code), salt, 32, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function backupMatches(code: string, stored: string): boolean {
  const [v, salt, hash] = stored.split("$");
  if (v !== "s1" || !salt || !hash) return false;
  const got = scryptSync(normalizeBackup(code), Buffer.from(salt, "base64url"), 32, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(got, Buffer.from(hash, "base64url"));
}

function newBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

async function replaceBackupCodes(
  q: <R>(sql: string, params?: unknown[]) => Promise<R[]>,
  userId: number,
): Promise<string[]> {
  const codes = newBackupCodes();
  await q(`DELETE FROM control.mfa_backup_codes WHERE user_id = $1`, [userId]);
  for (const code of codes) {
    await q(`INSERT INTO control.mfa_backup_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, hashBackup(code)]);
  }
  return codes;
}

// ── Users ───────────────────────────────────────────────────────────────────

export type MfaStatus = { enabled: boolean; enrolling: boolean; backupCodesLeft: number };

export async function mfaStatus(userId: number): Promise<MfaStatus> {
  const rows = await query<{ enabled: boolean; left: string }>(
    `SELECT m.enabled_at IS NOT NULL AS enabled,
            (SELECT COUNT(*) FROM control.mfa_backup_codes b
              WHERE b.user_id = m.user_id AND b.used_at IS NULL) AS left
       FROM control.user_mfa m WHERE m.user_id = $1`,
    [userId],
  );
  if (!rows[0]) return { enabled: false, enrolling: false, backupCodesLeft: 0 };
  return { enabled: rows[0].enabled, enrolling: !rows[0].enabled, backupCodesLeft: Number(rows[0].left) };
}

export async function mfaEnabled(userId: number): Promise<boolean> {
  return (await mfaStatus(userId)).enabled;
}

/** Start (or restart) enrolment: a fresh secret, not active until confirmed. */
export async function startEnrollment(userId: number, account: string): Promise<{ secret: string; uri: string } | null> {
  if (await mfaEnabled(userId)) return null;
  const secret = newTotpSecret();
  await query(
    `INSERT INTO control.user_mfa (user_id, secret_sealed) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET secret_sealed = EXCLUDED.secret_sealed, created_at = now()
       WHERE control.user_mfa.enabled_at IS NULL`,
    [userId, seal(key(), secret, aad(userId))],
  );
  return { secret, uri: otpauthUri(secret, account) };
}

async function userSecret(userId: number): Promise<{ secret: string; enabled: boolean } | null> {
  const rows = await query<{ secret_sealed: string; enabled: boolean }>(
    `SELECT secret_sealed, enabled_at IS NOT NULL AS enabled FROM control.user_mfa WHERE user_id = $1`,
    [userId],
  );
  return rows[0] ? { secret: openSealed(key(), rows[0].secret_sealed, aad(userId)), enabled: rows[0].enabled } : null;
}

/** Confirm enrolment with a first code; returns the backup codes (shown once). */
export async function confirmEnrollment(userId: number, code: string): Promise<string[] | null> {
  const row = await userSecret(userId);
  if (!row || row.enabled) return null;
  const step = matchTotp(row.secret, code);
  if (step === null || !(await claimStep(`user:${userId}`, step))) return null;
  return transaction(async (q) => {
    await q(`UPDATE control.user_mfa SET enabled_at = now() WHERE user_id = $1`, [userId]);
    return replaceBackupCodes(q, userId);
  });
}

/** Check a TOTP or backup code for an enrolled user. */
export async function verifyUserCode(userId: number, code: string): Promise<"totp" | "backup" | null> {
  const row = await userSecret(userId);
  if (!row || !row.enabled) return null;
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed.replace(/\s/g, ""))) {
    const step = matchTotp(row.secret, trimmed);
    return step !== null && (await claimStep(`user:${userId}`, step)) ? "totp" : null;
  }
  if (normalizeBackup(trimmed).length !== 10) return null;
  const codes = await query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM control.mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  for (const c of codes) {
    if (backupMatches(trimmed, c.code_hash)) {
      const used = await query<{ id: string }>(
        `UPDATE control.mfa_backup_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
        [c.id],
      );
      return used.length === 1 ? "backup" : null;
    }
  }
  return null;
}

export async function regenerateBackupCodes(userId: number): Promise<string[]> {
  return transaction((q) => replaceBackupCodes(q, userId));
}

export async function disableMfa(userId: number): Promise<void> {
  await transaction(async (q) => {
    await q(`DELETE FROM control.mfa_backup_codes WHERE user_id = $1`, [userId]);
    await q(`DELETE FROM control.user_mfa WHERE user_id = $1`, [userId]);
  });
}

// ── The owner password login ────────────────────────────────────────────────

export async function verifyOwnerCode(code: string): Promise<boolean> {
  const step = matchTotp(ownerTotpSecret(), code);
  return step !== null && (await claimStep("owner", step));
}
