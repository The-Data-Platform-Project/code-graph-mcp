import type { Metadata } from "next";
import { Mark } from "@/components/brand/Logo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  return (
    <main className="login-shell">
      <form className="login-card" method="post" action="/api/auth/login">
        <div className="logo">
          <div className="logo-mark">
            <Mark mono="white" size={22} />
          </div>
          <div className="logo-text">Context<span>Forge</span></div>
        </div>
        <label className="section-label" htmlFor="password">Owner password</label>
        <input
          id="password" name="password" type="password" className="login-input"
          autoComplete="current-password" autoFocus required
        />
        {next && <input type="hidden" name="next" value={next} />}
        {error === "config" ? (
          <p className="login-error">
            Sign-in is not set up on this deployment. The administrator needs to configure it.
          </p>
        ) : error ? (
          <p className="login-error">That password is not right.</p>
        ) : null}
        <button type="submit" className="readme-btn login-submit">Sign in</button>
        <p className="login-note">
          Single-owner access for now. Google and GitHub sign-in will replace this.{" "}
          <a href="/">Back to the site</a>
        </p>
      </form>
    </main>
  );
}
