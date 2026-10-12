/**
 * CAPTCHA after repeated failures: Cloudflare Turnstile (free, no tracking
 * cookies). Required once an IP or account has CAPTCHA_AFTER failures in the
 * window. If Turnstile is not configured, a challenge cannot be shown, so the
 * caller must refuse the attempt instead (fail closed).
 */
import "server-only";

export function turnstileSiteKey(): string {
  return process.env.TURNSTILE_SITE_KEY?.trim() ?? "";
}

function turnstileSecret(): string {
  return process.env.TURNSTILE_SECRET_KEY?.trim() ?? "";
}

export function captchaConfigured(): boolean {
  return !!(turnstileSiteKey() && turnstileSecret());
}

export async function verifyCaptcha(token: string, ip: string): Promise<boolean> {
  if (!captchaConfigured() || !token || token.length > 2048) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: turnstileSecret(), response: token, remoteip: ip }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("captcha verification failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
