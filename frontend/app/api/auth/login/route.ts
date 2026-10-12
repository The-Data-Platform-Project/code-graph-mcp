import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { logAuthEvent } from "@/lib/authlog";
import { LOGIN_FAILURES, LOGIN_PER_IP } from "@/lib/authpolicy";
import { captchaConfigured, verifyCaptcha } from "@/lib/captcha";
import { ownerPassword, ownerTenantSlug, ownerTotpSecret, sessionSecret } from "@/lib/env";
import { ownerPasswordProblem } from "@/lib/ownerpassword";
import { CAPTCHA_AFTER, clearFailures, consume, failureState, recordFailure } from "@/lib/ratelimit";
import { DEFAULT_TARGET, requestMeta, safeTarget, seeOther, startSession } from "@/lib/signin";

export const dynamic = "force-dynamic";

const ACCOUNT_KEY = "login:acct:owner";

function sameSecret(a: string, b: string): boolean {
  // Hash first so the comparison is over equal-length buffers and runs in
  // constant time regardless of how long the guess is.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Owner login, step 1 of 2: the password. A break-glass path next to sign-in
 * with GitHub. Step 2 is the TOTP code (/login/verify): a correct password
 * only earns a 10-minute "pending" session that can do nothing but submit it.
 *
 * In order: configuration → per-IP rate limit (5 per 15 min) → lockout and
 * backoff → CAPTCHA after 3 failures → password policy → constant-time compare.
 * Every refusal and failure is logged to control.auth_events.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const password = String(form?.get("password") ?? "");
  const target = safeTarget(String(form?.get("next") ?? DEFAULT_TARGET));
  const back = (error: string, retryAfter = 0) => {
    const params = new URLSearchParams({ error });
    if (retryAfter > 0) params.set("retry", String(retryAfter));
    if (target !== DEFAULT_TARGET) params.set("next", target);
    return seeOther(`/login?${params}`);
  };

  // A deployment without (or with too weak) sign-in settings — a preview
  // without OWNER_PASSWORD, say — must answer with a page, not a 500. The
  // reason goes to the server log; the visitor only learns sign-in is off.
  let expected: string;
  try {
    expected = ownerPassword();
    sessionSecret();
    ownerTotpSecret();
  } catch (err) {
    console.error("owner sign-in is not configured:", err instanceof Error ? err.message : err);
    return back("config");
  }

  const meta = requestMeta(request);
  const ipKey = `login:ip:${meta.ipHash}`;

  const rate = await consume(ipKey, LOGIN_PER_IP);
  if (!rate.allowed) {
    await logAuthEvent("owner_login", "blocked", "owner", meta.ipHash, { reason: "rate_limit" });
    return back("rate", rate.retryAfterSec);
  }

  const [ipFail, acctFail] = await Promise.all([failureState(ipKey), failureState(ACCOUNT_KEY)]);
  const lockedFor = Math.max(ipFail.lockedForSec, acctFail.lockedForSec);
  if (lockedFor > 0) {
    await logAuthEvent("owner_login", "blocked", "owner", meta.ipHash, { reason: "locked", seconds: lockedFor });
    return back("locked", lockedFor);
  }

  // CAPTCHA after 3 failures from this IP, or (when a CAPTCHA can be shown)
  // 3 failures against the account from anywhere. Without Turnstile, account
  // failures cannot demand a challenge nobody can solve: that would let any
  // stranger lock the owner out with three bad guesses. The IP alone is then
  // refused until its window passes, and account lockout still applies at 10.
  const captchaNeeded = captchaConfigured()
    ? Math.max(ipFail.failures, acctFail.failures) >= CAPTCHA_AFTER
    : ipFail.failures >= CAPTCHA_AFTER;
  if (captchaNeeded) {
    if (!captchaConfigured()) {
      await logAuthEvent("owner_login", "blocked", "owner", meta.ipHash, { reason: "captcha_unavailable" });
      return back("locked", LOGIN_FAILURES.windowSec);
    }
    const token = String(form?.get("cf-turnstile-response") ?? "");
    if (!(await verifyCaptcha(token, meta.ip))) {
      await logAuthEvent("owner_login", "blocked", "owner", meta.ipHash, { reason: "captcha" });
      return back("captcha");
    }
  }

  const weak = await ownerPasswordProblem(expected);
  if (weak) {
    console.error(weak);
    await logAuthEvent("owner_login", "blocked", "owner", meta.ipHash, { reason: "weak_owner_password" });
    return back("config");
  }

  if (!password || password.length > 1024 || !sameSecret(password, expected)) {
    const [ip, acct] = await Promise.all([
      recordFailure(ipKey, LOGIN_FAILURES),
      recordFailure(ACCOUNT_KEY, LOGIN_FAILURES),
    ]);
    await logAuthEvent("owner_login", "failure", "owner", meta.ipHash, {
      reason: "bad_password",
      failures: Math.max(ip.failures, acct.failures),
    });
    // A fixed delay on top of the backoff makes guessing slow without state.
    await new Promise((r) => setTimeout(r, 600));
    const wait = Math.max(ip.lockedForSec, acct.lockedForSec);
    return wait > 0 ? back("locked", wait) : back("1");
  }

  await clearFailures(ipKey, ACCOUNT_KEY);
  await logAuthEvent("owner_login", "success", "owner", meta.ipHash, { step: "password" });
  const params = new URLSearchParams();
  if (target !== DEFAULT_TARGET) params.set("next", target);
  return startSession(
    request,
    { sub: "owner", userId: null, tenant: ownerTenantSlug(), role: "owner", mfa: "pending" },
    seeOther(`/login/verify${params.size ? `?${params}` : ""}`),
  );
}
