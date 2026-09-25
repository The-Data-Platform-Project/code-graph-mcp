export const dynamic = "force-dynamic";

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
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v4m0 10v4M3 12h4m10 0h4" />
            </svg>
          </div>
          <div className="logo-text">Code<span>Graph</span></div>
        </div>
        <label className="section-label" htmlFor="password">Owner password</label>
        <input
          id="password" name="password" type="password" className="login-input"
          autoComplete="current-password" autoFocus required
        />
        {next && <input type="hidden" name="next" value={next} />}
        {error && <p className="login-error">That password is not right.</p>}
        <button type="submit" className="readme-btn login-submit">Sign in</button>
        <p className="login-note">
          Single-owner access for now. Google and GitHub sign-in will replace this.
        </p>
      </form>
    </main>
  );
}
