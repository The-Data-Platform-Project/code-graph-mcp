import { NextRequest } from "next/server";
import { logAuthEvent } from "@/lib/authlog";
import { MFA_FAILURES, MFA_PER_IP, MFA_PER_SESSION } from "@/lib/authpolicy";
import { verifyOwnerCode, verifyUserCode } from "@/lib/mfa";
import { clearFailures, consume, failureState, recordFailure } from "@/lib/ratelimit";
import { clearSessionCookie, idHash, revokeSession } from "@/lib/sessions";
import { DEFAULT_TARGET, requestMeta, safeTarget, seeOther, startSession } from "@/lib/signin";
import { getPendingSession } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/**
 * Sign-in, step 2: the 2FA code (authenticator app, or a backup code).
 *
 * Only a "pending" session (password or GitHub done, at most 10 minutes old)
 * may submit. Limits: 5 tries per session, 10 per IP per 15 minutes; 5
 * failures lock the account's 2FA for 15 minutes, doubling on repeat. On
 * success the pending session is revoked and a new one issued, so the id that
 * was exposed before the second factor never becomes a full session.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const code = String(form?.get("code") ?? "").slice(0, 64);
  const target = safeTarget(String(form?.get("next") ?? DEFAULT_TARGET));
  const back = (error: string, retryAfter = 0) => {
    const params = new URLSearchParams({ error });
    if (retryAfter > 0) params.set("retry", String(retryAfter));
    if (target !== DEFAULT_TARGET) params.set("next", target);
    return seeOther(`/login/verify?${params}`);
  };

  const pending = await getPendingSession();
  if (!pending) {
    const res = seeOther("/login?error=expired");
    clearSessionCookie(res);
    return res;
  }
  const { sid, row } = pending;
  const meta = requestMeta(request);
  const subjectKey = `mfa:subj:${row.sub}`;

  for (const [key, window] of [
    [`mfa:ip:${meta.ipHash}`, MFA_PER_IP],
    [`mfa:sess:${idHash(sid)}`, MFA_PER_SESSION],
  ] as const) {
    const rate = await consume(key, window);
    if (!rate.allowed) {
      await logAuthEvent("mfa_verify", "blocked", row.sub, meta.ipHash, { reason: "rate_limit" });
      return back("rate", rate.retryAfterSec);
    }
  }
  const lock = await failureState(subjectKey);
  if (lock.lockedForSec > 0) {
    await logAuthEvent("mfa_verify", "blocked", row.sub, meta.ipHash, { reason: "locked" });
    return back("locked", lock.lockedForSec);
  }

  let method: "totp" | "backup" | null = null;
  if (row.sub === "owner") {
    method = (await verifyOwnerCode(code)) ? "totp" : null;
  } else if (row.user_id) {
    method = await verifyUserCode(Number(row.user_id), code);
  }

  if (!method) {
    const state = await recordFailure(subjectKey, MFA_FAILURES);
    await logAuthEvent("mfa_verify", "failure", row.sub, meta.ipHash, { failures: state.failures });
    return state.lockedForSec > 0 ? back("locked", state.lockedForSec) : back("1");
  }

  await clearFailures(subjectKey);
  await revokeSession(sid);
  await logAuthEvent("mfa_verify", "success", row.sub, meta.ipHash, { method });
  return startSession(
    request,
    {
      sub: row.sub,
      userId: row.user_id ? Number(row.user_id) : null,
      tenant: row.tenant_slug,
      role: row.role,
      mfa: "verified",
    },
    seeOther(method === "backup" ? "/settings?backup=used#security" : target),
  );
}
