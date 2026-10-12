/**
 * Rate limiting, exponential backoff and lockout, kept in Postgres
 * (control.rate_limits) so every serverless instance sees the same counts.
 *
 * Two kinds of row:
 *   `rl:<scope>:<who>`    requests in a fixed window (allowed or not)
 *   `fail:<scope>:<who>`  failed attempts in a window, which drive
 *       - the CAPTCHA threshold (CAPTCHA_AFTER failures),
 *       - exponential backoff: after BACKOFF_AFTER failures, each further one
 *         locks for 2^(n - BACKOFF_AFTER) seconds, capped at 15 minutes,
 *       - lockout: at `lockAfter` failures, a lock of 15 min × 2^level
 *         (capped at 24 h) that doubles each time it recurs.
 */
import "server-only";
import { query } from "./pool";

export const CAPTCHA_AFTER = 3;
const BACKOFF_AFTER = 3;
const MAX_BACKOFF_SEC = 15 * 60;
const MAX_LOCK_SEC = 24 * 60 * 60;

export type Window = { limit: number; windowSec: number };

/** Count one request. `allowed` is false once the window's limit is passed. */
export async function consume(
  key: string,
  { limit, windowSec }: Window,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const [row] = await query<{ hits: number; reset_in: number }>(
    `INSERT INTO control.rate_limits AS r (key, window_start, hits)
     VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       hits = CASE WHEN r.window_start < now() - make_interval(secs => $2) THEN 1 ELSE r.hits + 1 END,
       window_start = CASE WHEN r.window_start < now() - make_interval(secs => $2) THEN now() ELSE r.window_start END
     RETURNING hits,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2) - now()))))::int AS reset_in`,
    [`rl:${key}`, windowSec],
  );
  return { allowed: row.hits <= limit, retryAfterSec: row.reset_in };
}

export type FailureState = { failures: number; lockedForSec: number };

export async function failureState(key: string): Promise<FailureState> {
  const rows = await query<{ failures: number; locked_for: number }>(
    `SELECT failures,
            GREATEST(0, CEIL(EXTRACT(EPOCH FROM (COALESCE(locked_until, now()) - now()))))::int AS locked_for
       FROM control.rate_limits WHERE key = $1`,
    [`fail:${key}`],
  );
  return rows[0] ? { failures: rows[0].failures, lockedForSec: rows[0].locked_for } : { failures: 0, lockedForSec: 0 };
}

/** Record a failed attempt; returns the new state, including any lock it set. */
export async function recordFailure(
  key: string,
  { windowSec, lockAfter, lockSec }: { windowSec: number; lockAfter: number; lockSec: number },
): Promise<FailureState> {
  const [row] = await query<{ failures: number; lock_level: number }>(
    `INSERT INTO control.rate_limits AS r (key, window_start, failures)
     VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN r.window_start < now() - make_interval(secs => $2)
                        AND (r.locked_until IS NULL OR r.locked_until < now())
                       THEN 1 ELSE r.failures + 1 END,
       window_start = CASE WHEN r.window_start < now() - make_interval(secs => $2)
                            AND (r.locked_until IS NULL OR r.locked_until < now())
                           THEN now() ELSE r.window_start END
     RETURNING failures, lock_level`,
    [`fail:${key}`, windowSec],
  );
  let lockFor = 0;
  let level = row.lock_level;
  if (row.failures >= lockAfter) {
    lockFor = Math.min(lockSec * 2 ** level, MAX_LOCK_SEC);
    level += 1;
  } else if (row.failures > BACKOFF_AFTER) {
    lockFor = Math.min(2 ** (row.failures - BACKOFF_AFTER), MAX_BACKOFF_SEC);
  }
  if (lockFor > 0) {
    await query(
      `UPDATE control.rate_limits
          SET locked_until = GREATEST(COALESCE(locked_until, now()), now() + make_interval(secs => $2)),
              lock_level = $3,
              failures = CASE WHEN $4 THEN 0 ELSE failures END,
              window_start = CASE WHEN $4 THEN now() ELSE window_start END
        WHERE key = $1`,
      [`fail:${key}`, lockFor, level, row.failures >= lockAfter],
    );
  }
  return { failures: row.failures, lockedForSec: lockFor };
}

export async function clearFailures(...keys: string[]): Promise<void> {
  if (!keys.length) return;
  await query(`DELETE FROM control.rate_limits WHERE key = ANY($1)`, [keys.map((k) => `fail:${k}`)]);
}
