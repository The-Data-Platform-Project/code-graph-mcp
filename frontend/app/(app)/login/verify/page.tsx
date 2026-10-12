import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Mark } from "@/components/brand/Logo";
import { getPendingSession } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Two-factor code", robots: { index: false, follow: false } };

function waitText(seconds: number): string {
  return seconds <= 60 ? `${Math.max(1, seconds)} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * Sign-in, step 2. Reachable only with a "pending" session: the password (or
 * GitHub) has been accepted and a 2FA code is owed. The session expires in
 * 10 minutes; the form posts to /api/auth/mfa/verify.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; retry?: string }>;
}) {
  const pending = await getPendingSession();
  if (!pending) redirect("/login?error=expired");
  const { error, next, retry } = await searchParams;
  const wait = Number(retry) || 0;
  const message =
    error === "rate" ? `Too many attempts. Try again in ${waitText(wait)}.`
    : error === "locked" ? `Too many wrong codes. Two-factor sign-in is paused for ${waitText(wait)}.`
    : error ? "That code is not right. Check the time on your phone, or use a backup code."
    : null;
  return (
    <main className="login-shell">
      <form className="login-card" method="post" action="/api/auth/mfa/verify">
        <div className="logo">
          <div className="logo-mark">
            <Mark mono="white" size={22} />
          </div>
          <div className="logo-text">Code<span>Graph</span></div>
        </div>
        <label className="section-label" htmlFor="code">Authenticator code</label>
        <p className="login-note">
          Enter the 6-digit code from your authenticator app, or one of your backup codes.
        </p>
        <input
          id="code" name="code" className="login-input" inputMode="text"
          autoComplete="one-time-code" autoFocus required maxLength={32}
          pattern="[0-9 ]{6,7}|[A-Za-z2-7-]{10,11}" title="6 digits, or a backup code like abcde-fghij"
        />
        {next && <input type="hidden" name="next" value={next} />}
        {message && <p className="login-error" role="alert">{message}</p>}
        <button type="submit" className="readme-btn login-submit">Verify</button>
        <p className="login-note">
          Lost your device and your backup codes? Ask the administrator to reset your 2FA.
        </p>
      </form>
      <form method="post" action="/api/auth/logout" className="login-cancel">
        <button type="submit" className="link-button">Cancel and sign out</button>
      </form>
    </main>
  );
}
