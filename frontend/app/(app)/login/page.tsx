import type { Metadata } from "next";
import { Mark } from "@/components/brand/Logo";
import { githubOAuth } from "@/lib/env";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

const ERRORS: Record<string, string> = {
  config: "Sign-in is not set up on this deployment. The administrator needs to configure it.",
  github_denied: "GitHub sign-in was cancelled.",
  github_state: "That sign-in link expired or came from another browser. Try again.",
  github_exchange: "GitHub did not confirm the sign-in. Try again.",
  suspended: "This account is suspended. Ask the administrator.",
  "1": "That password is not right.",
};

function GithubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; status?: string; who?: string }>;
}) {
  const { error, next, status, who } = await searchParams;
  const github = githubOAuth() !== null;
  const githubHref = `/api/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`;
  return (
    <main className="login-shell">
      <div className="login-card">
        <div className="logo">
          <div className="logo-mark">
            <Mark mono="white" size={22} />
          </div>
          <div className="logo-text">Context<span>Forge</span></div>
        </div>

        {status === "pending" ? (
          <p className="login-notice">
            Thanks{who ? `, ${who}` : ""}. Your account is waiting for approval. Once the
            administrator approves it, sign in again here.
          </p>
        ) : error ? (
          <p className="login-error">{ERRORS[error] ?? ERRORS["1"]}</p>
        ) : null}

        {github && (
          <>
            <a className="readme-btn login-submit login-github" href={githubHref}>
              <GithubIcon /> Continue with GitHub
            </a>
            <p className="login-note">
              GitHub is asked only who you are. You choose which repositories to share
              later, with fine-grained tokens you create for exactly those repositories.
            </p>
          </>
        )}

        <form className="login-owner" method="post" action="/api/auth/login">
          <label className="section-label" htmlFor="password">Owner password</label>
          <input
            id="password" name="password" type="password" className="login-input"
            autoComplete="current-password" autoFocus={!github} required
          />
          {next && <input type="hidden" name="next" value={next} />}
          <button type="submit" className="readme-btn login-submit">Sign in</button>
        </form>
        <p className="login-note">
          {github
            ? "The owner password is the administrator's break-glass sign-in."
            : "Single-owner access. Sign-in with GitHub appears here once it is configured."}{" "}
          <a href="/">Back to the site</a>
        </p>
      </div>
    </main>
  );
}
