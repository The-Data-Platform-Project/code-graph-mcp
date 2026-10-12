"use client";

/**
 * /settings: a tenant's GitHub tokens, connected repositories and index runs,
 * plus sign-up approvals for platform admins.
 *
 * Tokens are requested from GitHub, not made here: GitHub has no API to mint
 * a fine-grained token, so "Create on GitHub" opens GitHub's own form with
 * the name, owner, expiry and permissions pre-filled (read-only Contents and
 * Metadata, optionally Webhooks), and the person picks the repositories and
 * pastes the result back. Every call goes through /api/settings, scoped to
 * the signed-in tenant on the server.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Mark } from "./brand/Logo";

type Token = {
  id: number;
  label: string;
  githubLogin: string;
  hint: string;
  expiresAt: string | null;
  createdAt: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  connections: number;
};

type Job = {
  id: number;
  repoName: string;
  trigger: "schedule" | "push" | "manual";
  status: "queued" | "running" | "succeeded" | "failed";
  commitSha: string | null;
  error: string | null;
  stats: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
};

type Connection = {
  repoName: string;
  externalRepo: string;
  branch: string | null;
  gitRef: string | null;
  tokenId: number | null;
  tokenLabel: string | null;
  indexDaily: boolean;
  indexOnPush: boolean;
  lastIndexedAt: string | null;
  lastJob: Job | null;
};

type TokenRepo = { fullName: string; private: boolean; defaultBranch: string; canAdmin: boolean };

type User = {
  id: number;
  githubLogin: string;
  displayName: string | null;
  email: string | null;
  status: "pending" | "active" | "suspended";
  isPlatformAdmin: boolean;
  tenant: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

type Props = {
  tenantName: string;
  githubLogin: string | null;
  canManage: boolean;
  /** Decided on the server (canAdminister); only says whether to show admin UI. */
  isAdmin: boolean;
  /** A platform admin whose session has no second factor yet. */
  adminNeedsMfa: boolean;
};

type MfaInfo = {
  enabled: boolean;
  enrolling?: boolean;
  backupCodesLeft?: number;
  required: boolean;
  sessionVerified: boolean;
  managedByEnvironment?: boolean;
};

async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && data.error) throw new Error(data.error);
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return data;
}

function when(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function daysLeft(value: string | null): number | null {
  if (!value) return null;
  return Math.floor((new Date(value).getTime() - Date.now()) / 86_400_000);
}

/** GitHub's token form, pre-filled (docs: "Pre-filling fine-grained PAT details"). */
function tokenRequestUrl(opts: {
  name: string;
  owner: string;
  days: string;
  webhooks: boolean;
}): string {
  const params = new URLSearchParams({
    name: opts.name.slice(0, 40),
    description:
      "CodeGraph code graph: read repository contents to index them" +
      (opts.webhooks ? ", and add a push webhook so each push re-indexes." : "."),
    expires_in: opts.days,
    contents: "read",
    metadata: "read",
  });
  if (opts.owner.trim()) params.set("target_name", opts.owner.trim());
  if (opts.webhooks) params.set("repository_hooks", "write");
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

function StatusBadge({ job }: { job: Job | null }) {
  if (!job) return <span className="badge badge-muted">not indexed yet</span>;
  const label = job.status === "succeeded" && job.stats?.unchanged ? "up to date" : job.status;
  return <span className={`badge badge-${job.status}`}>{label}</span>;
}

export default function Settings({ tenantName, githubLogin, canManage, isAdmin, adminNeedsMfa }: Props) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [indexer, setIndexer] = useState<{ configured: boolean; webhookUrl: string | null }>({
    configured: false,
    webhookUrl: null,
  });
  const [users, setUsers] = useState<User[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const say = useCallback(
    (kind: "ok" | "error", text: string) => setNotice({ kind, text }),
    [],
  );

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        api<{ tokens: Token[] }>("/api/settings/github-tokens"),
        api<{ connections: Connection[]; jobs: Job[]; indexer: typeof indexer }>(
          "/api/settings/connections",
        ),
      ]);
      setTokens(t.tokens);
      setConnections(c.connections);
      setJobs(c.jobs);
      setIndexer(c.indexer);
      if (isAdmin) setUsers((await api<{ users: User[] }>("/api/admin/users")).users);
    } catch (err) {
      say("error", err instanceof Error ? err.message : String(err));
    }
  }, [isAdmin, say]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a run is queued or running, refresh every few seconds.
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [active, load]);

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setNotice(null);
    try {
      const message = await fn();
      if (message) say("ok", message);
      await load();
    } catch (err) {
      say("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settings-shell">
      <header className="settings-top">
        <a className="logo settings-logo" href="/graph">
          <div className="logo-mark">
            <Mark mono="white" size={20} />
          </div>
          <div className="logo-text">Code<span>Graph</span></div>
        </a>
        <nav className="settings-nav">
          <a href="/graph">Graph</a>
          <a href="/docs/user-guide">User guide</a>
          {isAdmin && <a href="/admin/guide">Admin guide</a>}
          <form method="post" action="/api/auth/logout">
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </header>

      <main className="settings-main">
        <h1>Settings</h1>
        <p className="settings-lead">
          {tenantName}
          {githubLogin ? <> · signed in as <b>{githubLogin}</b></> : " · owner password sign-in"}
        </p>

        {notice && (
          <p className={`settings-notice ${notice.kind}`} role="status">
            {notice.text}
            <button aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
          </p>
        )}

        {adminNeedsMfa && (
          <p className="settings-notice error" role="status">
            Administrator features are locked until you turn on two-factor authentication below.
          </p>
        )}

        <SecuritySection say={say} />

        <TokensSection
          tokens={tokens}
          githubLogin={githubLogin}
          canManage={canManage}
          busy={busy}
          run={run}
        />

        <ConnectionsSection
          tokens={tokens}
          connections={connections}
          indexer={indexer}
          canManage={canManage}
          busy={busy}
          run={run}
          say={say}
        />

        <JobsSection jobs={jobs} />

        {isAdmin && <UsersSection users={users} busy={busy} run={run} />}
      </main>
    </div>
  );
}

type Run = (key: string, fn: () => Promise<string | void>) => Promise<void>;

// ── Security: two-factor authentication and sessions ────────────────────────

function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="settings-step">
      <h3>Save your backup codes</h3>
      <p className="settings-help">
        Each code signs you in once if you lose your phone. They are shown only now: store them in
        a password manager.
      </p>
      <pre className="settings-codes mono">{codes.join("\n")}</pre>
      <div className="settings-inline">
        <button
          type="button"
          className="settings-button"
          onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).catch(() => {})}
        >
          Copy
        </button>
        <button type="button" className="settings-button primary" onClick={onDone}>
          I have saved them
        </button>
      </div>
    </div>
  );
}

function SecuritySection({ say }: { say: (kind: "ok" | "error", text: string) => void }) {
  const [info, setInfo] = useState<MfaInfo | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api<MfaInfo>("/api/auth/mfa"));
    } catch (err) {
      say("error", err instanceof Error ? err.message : String(err));
    }
  }, [say]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      say("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setCode("");
      await load();
    }
  }

  const codeInput = (
    <input
      id="mfa-code"
      className="mono"
      inputMode="text"
      autoComplete="one-time-code"
      placeholder="6-digit code"
      maxLength={32}
      value={code}
      onChange={(e) => setCode(e.target.value)}
    />
  );

  return (
    <section className="settings-card" id="security">
      <h2>Security</h2>
      {!info ? (
        <p className="settings-empty">Loading…</p>
      ) : info.managedByEnvironment ? (
        <p className="settings-help">
          This is the owner password login. Its second factor is the authenticator set up from
          <code> OWNER_TOTP_SECRET</code>; change it in the deployment&apos;s environment.
        </p>
      ) : (
        <>
          <p className="settings-help">
            Two-factor authentication asks for a code from an authenticator app (1Password, Google
            Authenticator, Authy…) each time you sign in.
            {info.required && " It is required for administrators."}
          </p>
          <p>
            <span className={`badge ${info.enabled ? "badge-succeeded" : "badge-failed"}`}>
              {info.enabled ? "2FA on" : "2FA off"}
            </span>
            {info.enabled && (
              <span className="muted"> · {info.backupCodesLeft} backup codes left</span>
            )}
          </p>

          {codes && <BackupCodes codes={codes} onDone={() => setCodes(null)} />}

          {!info.enabled && !setup && (
            <button
              className="settings-button primary"
              disabled={busy}
              onClick={() => act(async () => {
                setSetup(await api<{ secret: string; qrSvg: string }>("/api/auth/mfa/enroll", { method: "POST" }));
              })}
            >
              Turn on two-factor authentication
            </button>
          )}

          {!info.enabled && setup && (
            <form
              className="settings-step"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const r = await api<{ backupCodes: string[] }>("/api/auth/mfa/confirm", { method: "POST", json: { code } });
                  setSetup(null);
                  setCodes(r.backupCodes);
                  say("ok", "Two-factor authentication is on.");
                });
              }}
            >
              <h3>Scan this with your authenticator app</h3>
              <img
                className="settings-qr"
                alt="QR code for your authenticator app"
                src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`}
              />
              <p className="settings-help">
                Or enter this key by hand: <code className="mono">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code>
              </p>
              <label className="settings-grid">Then enter the code it shows{codeInput}</label>
              <button className="settings-button primary" disabled={busy || code.trim().length < 6} type="submit">
                Confirm
              </button>
            </form>
          )}

          {info.enabled && (
            <div className="settings-step">
              <label className="settings-grid">Current code, for the actions below{codeInput}</label>
              <div className="settings-inline">
                <button
                  className="settings-button"
                  disabled={busy || code.trim().length < 6}
                  onClick={() => act(async () => {
                    const r = await api<{ backupCodes: string[] }>("/api/auth/mfa/backup-codes", { method: "POST", json: { code } });
                    setCodes(r.backupCodes);
                  })}
                >
                  New backup codes
                </button>
                {!info.required && (
                  <button
                    className="settings-button"
                    disabled={busy || code.trim().length < 6}
                    onClick={() => act(async () => {
                      await api("/api/auth/mfa/disable", { method: "POST", json: { code } });
                      say("ok", "Two-factor authentication is off. Other sessions were signed out.");
                    })}
                  >
                    Turn off 2FA
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div className="settings-inline">
        <button
          className="settings-button"
          disabled={busy}
          onClick={() => act(async () => {
            const r = await api<{ revoked: number }>("/api/auth/sessions", { method: "DELETE" });
            say("ok", `Signed out ${r.revoked} other session${r.revoked === 1 ? "" : "s"}.`);
          })}
        >
          Sign out everywhere else
        </button>
      </div>
    </section>
  );
}

// ── GitHub tokens ───────────────────────────────────────────────────────────

function TokensSection({
  tokens, githubLogin, canManage, busy, run,
}: {
  tokens: Token[];
  githubLogin: string | null;
  canManage: boolean;
  busy: string | null;
  run: Run;
}) {
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState(githubLogin ?? "");
  const [days, setDays] = useState("90");
  const [webhooks, setWebhooks] = useState(true);
  const [token, setToken] = useState("");

  const requestUrl = useMemo(
    () => tokenRequestUrl({
      name: `CodeGraph ${label || owner || "repos"}`,
      owner, days, webhooks,
    }),
    [label, owner, days, webhooks],
  );

  return (
    <section className="settings-card">
      <h2>GitHub tokens</h2>
      <p className="settings-help">
        Keep one fine-grained token per set of repositories: say, one for your own and
        one per organization. Each is limited on GitHub to the repositories you pick,
        stored encrypted, and used only to read those repositories (and, if you allow
        it, to add a push webhook).
      </p>

      {tokens.length === 0 ? (
        <p className="settings-empty">No tokens yet.</p>
      ) : (
        <ul className="settings-list">
          {tokens.map((t) => {
            const left = daysLeft(t.expiresAt);
            return (
              <li key={t.id} className="settings-row">
                <div className="settings-row-main">
                  <b>{t.label}</b>
                  <span className="mono">github_pat_…{t.hint}</span>
                  <span className="muted">
                    {t.githubLogin} · {t.connections} repo{t.connections === 1 ? "" : "s"} ·{" "}
                    {left === null ? "no expiry" : left < 0 ? "expired" : `expires in ${left} days`}
                  </span>
                  {t.lastError && <span className="settings-error">{t.lastError}</span>}
                </div>
                {canManage && (
                  <div className="settings-row-actions">
                    <button
                      disabled={busy !== null}
                      onClick={() => run(`check-${t.id}`, async () => {
                        const r = await fetch(`/api/settings/github-tokens/${t.id}`, { method: "POST" })
                          .then((x) => x.json() as Promise<{ ok: boolean; error?: string }>);
                        if (!r.ok) throw new Error(r.error ?? "GitHub rejected the token");
                        return `"${t.label}" is valid.`;
                      })}
                    >
                      Check
                    </button>
                    <button
                      className="danger"
                      disabled={busy !== null}
                      onClick={() => {
                        if (!confirm(`Remove "${t.label}"? Repositories using it lose private access.`)) return;
                        void run(`del-${t.id}`, async () => {
                          await api(`/api/settings/github-tokens/${t.id}`, { method: "DELETE" });
                          return `Removed "${t.label}". Revoke it on GitHub too if you no longer need it.`;
                        });
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <div className="settings-steps">
          <div className="settings-step">
            <h3><span>1</span> Request a token on GitHub</h3>
            <div className="settings-grid">
              <label>
                Label
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. work repos" maxLength={80} />
              </label>
              <label>
                Repository owner
                <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="your login or an organization" />
              </label>
              <label>
                Expires in
                <select value={days} onChange={(e) => setDays(e.target.value)}>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="180">180 days</option>
                  <option value="366">366 days</option>
                  <option value="none">never (not recommended)</option>
                </select>
              </label>
            </div>
            <label className="settings-check">
              <input type="checkbox" checked={webhooks} onChange={(e) => setWebhooks(e.target.checked)} />
              Also allow adding push webhooks, so every push re-indexes (Webhooks: read and write)
            </label>
            <a className="settings-button primary" href={requestUrl} target="_blank" rel="noopener noreferrer">
              Create on GitHub ↗
            </a>
            <p className="settings-help">
              GitHub opens with the name, owner, expiry and read-only permissions filled in.
              Under <b>Repository access</b> choose <b>Only select repositories</b>, pick them,
              then <b>Generate token</b> and copy it.
            </p>
          </div>

          <form
            className="settings-step"
            onSubmit={(e) => {
              e.preventDefault();
              void run("add-token", async () => {
                const r = await api<{ githubLogin: string }>("/api/settings/github-tokens", {
                  method: "POST",
                  json: { label: label || owner || "GitHub", token },
                });
                setToken("");
                setLabel("");
                return `Token saved for ${r.githubLogin}. Connect its repositories below.`;
              });
            }}
          >
            <h3><span>2</span> Paste it here</h3>
            <input
              className="mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value.trim())}
              placeholder="github_pat_…"
            />
            <button className="settings-button primary" disabled={!token || busy !== null} type="submit">
              Save token
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

// ── Repositories ────────────────────────────────────────────────────────────

function ConnectionsSection({
  tokens, connections, indexer, canManage, busy, run, say,
}: {
  tokens: Token[];
  connections: Connection[];
  indexer: { configured: boolean; webhookUrl: string | null };
  canManage: boolean;
  busy: string | null;
  run: Run;
  say: (kind: "ok" | "error", text: string) => void;
}) {
  const [tokenId, setTokenId] = useState<string>("");
  const [repos, setRepos] = useState<TokenRepo[] | null>(null);
  const [repo, setRepo] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [manual, setManual] = useState<Record<string, { url: string; secret: string; settingsUrl: string }>>({});

  useEffect(() => {
    setRepos(null);
    setRepo("");
    if (!tokenId) return;
    fetch(`/api/settings/github-tokens/${tokenId}/repos`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ repos?: TokenRepo[]; error?: string }>)
      .then((r) => (r.repos ? setRepos(r.repos) : say("error", r.error ?? "could not list repositories")))
      .catch((err) => say("error", String(err)));
  }, [tokenId, say]);

  const connected = new Set(connections.map((c) => c.externalRepo.toLowerCase()));
  const patch = (c: Connection, body: Record<string, unknown>) =>
    run(`patch-${c.repoName}`, async () => {
      await api(`/api/settings/connections/${encodeURIComponent(c.repoName)}`, { method: "PATCH", json: body });
    });

  return (
    <section className="settings-card">
      <h2>Repositories</h2>
      <p className="settings-help">
        Each connected repository is indexed from GitHub into your graph
        {indexer.configured
          ? ": once a day, on every push (with a webhook), and whenever you press Index now."
          : ". No indexer is deployed yet, so connections are recorded but not indexed."}
      </p>

      {connections.length === 0 ? (
        <p className="settings-empty">No repositories connected.</p>
      ) : (
        <ul className="settings-list">
          {connections.map((c) => (
            <li key={c.repoName} className="settings-row settings-conn">
              <div className="settings-row-main">
                <b>{c.repoName}</b>
                <span className="muted">
                  {c.externalRepo}
                  {c.branch ? ` @ ${c.branch}` : " @ default branch"}
                  {c.gitRef && /^[0-9a-f]{40}$/.test(c.gitRef) ? ` · ${c.gitRef.slice(0, 7)}` : ""}
                  {" · indexed "}{when(c.lastIndexedAt)}
                </span>
                <span>
                  <StatusBadge job={c.lastJob} />
                  {c.lastJob?.status === "failed" && c.lastJob.error && (
                    <span className="settings-error"> {c.lastJob.error}</span>
                  )}
                </span>
                {canManage && (
                  <div className="settings-inline">
                    <label>
                      Token
                      <select
                        value={c.tokenId ?? ""}
                        disabled={busy !== null}
                        onChange={(e) => void patch(c, { tokenId: e.target.value || null })}
                      >
                        <option value="">none (public repo)</option>
                        {tokens.map((t) => (
                          <option key={t.id} value={t.id}>{t.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="settings-check">
                      <input
                        type="checkbox" checked={c.indexDaily} disabled={busy !== null}
                        onChange={(e) => void patch(c, { indexDaily: e.target.checked })}
                      />
                      daily
                    </label>
                    <label className="settings-check">
                      <input
                        type="checkbox" checked={c.indexOnPush} disabled={busy !== null}
                        onChange={(e) => void patch(c, { indexOnPush: e.target.checked })}
                      />
                      on push
                    </label>
                  </div>
                )}
                {manual[c.repoName] && (
                  <div className="settings-manual">
                    On <a href={manual[c.repoName].settingsUrl} target="_blank" rel="noopener noreferrer">GitHub → Webhooks → Add webhook</a>:
                    payload URL <code>{manual[c.repoName].url}</code>, content type
                    <code>application/json</code>, secret <code>{manual[c.repoName].secret}</code>,
                    events: just the push event.
                  </div>
                )}
              </div>
              {canManage && (
                <div className="settings-row-actions">
                  <button
                    disabled={busy !== null || !indexer.configured}
                    onClick={() => run(`index-${c.repoName}`, async () => {
                      const r = await api<{ message: string }>(
                        `/api/settings/connections/${encodeURIComponent(c.repoName)}/index`,
                        { method: "POST" },
                      );
                      return `${c.repoName}: ${r.message}.`;
                    })}
                  >
                    Index now
                  </button>
                  <button
                    disabled={busy !== null || !indexer.configured || !c.indexOnPush}
                    title="Register the push webhook on GitHub"
                    onClick={() => run(`hook-${c.repoName}`, async () => {
                      const path = `/api/settings/connections/${encodeURIComponent(c.repoName)}/webhook`;
                      const r = await api<{ ok: boolean; existed?: boolean; reason?: string }>(path, { method: "POST" });
                      if (r.ok) return r.existed ? "The webhook was already there." : "Webhook added: each push now re-indexes.";
                      const m = await api<{ url: string; secret: string; settingsUrl: string }>(path);
                      setManual((s) => ({ ...s, [c.repoName]: m }));
                      return `Could not add it automatically (${r.reason}). Add it by hand with the details shown.`;
                    })}
                  >
                    Webhook
                  </button>
                  <button
                    className="danger"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!confirm(`Disconnect ${c.repoName}? Indexing stops; the graph stays until an admin removes it.`)) return;
                      void run(`del-${c.repoName}`, async () => {
                        await api(`/api/settings/connections/${encodeURIComponent(c.repoName)}`, { method: "DELETE" });
                        return `Disconnected ${c.repoName}.`;
                      });
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <form
          className="settings-step"
          onSubmit={(e) => {
            e.preventDefault();
            void run("connect", async () => {
              const r = await api<{ repoName: string; index: { ok: boolean; message: string } }>(
                "/api/settings/connections",
                { method: "POST", json: { externalRepo: repo, repoName: name, branch, tokenId: tokenId || null } },
              );
              setRepo("");
              setName("");
              setBranch("");
              return r.index.ok
                ? `Connected ${r.repoName}; its first index run is ${r.index.message}.`
                : `Connected ${r.repoName}. Not indexed yet: ${r.index.message}.`;
            });
          }}
        >
          <h3>Connect a repository</h3>
          <div className="settings-grid">
            <label>
              Token
              <select value={tokenId} onChange={(e) => setTokenId(e.target.value)}>
                <option value="">none (public repo)</option>
                {tokens.map((t) => (
                  <option key={t.id} value={t.id}>{t.label} ({t.githubLogin})</option>
                ))}
              </select>
            </label>
            <label>
              Repository
              {tokenId && repos ? (
                <select
                  value={repo}
                  onChange={(e) => {
                    setRepo(e.target.value);
                    setName(e.target.value.split("/")[1] ?? "");
                  }}
                >
                  <option value="">choose…</option>
                  {repos.map((r) => (
                    <option key={r.fullName} value={r.fullName} disabled={connected.has(r.fullName.toLowerCase())}>
                      {r.fullName}{r.private ? " (private)" : ""}
                      {connected.has(r.fullName.toLowerCase()) ? " — connected" : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={repo}
                  onChange={(e) => {
                    setRepo(e.target.value.trim());
                    setName(e.target.value.trim().split("/")[1] ?? "");
                  }}
                  placeholder={tokenId ? "loading…" : "owner/repository"}
                />
              )}
            </label>
            <label>
              Name in the graph
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="defaults to the repo name" />
            </label>
            <label>
              Branch
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" />
            </label>
          </div>
          {tokenId && repos && repos.length === 0 && (
            <p className="settings-help">This token was not granted any repositories on GitHub.</p>
          )}
          <button className="settings-button primary" disabled={!repo || busy !== null} type="submit">
            Connect
          </button>
        </form>
      )}
    </section>
  );
}

// ── Index runs ──────────────────────────────────────────────────────────────

function JobsSection({ jobs }: { jobs: Job[] }) {
  return (
    <section className="settings-card">
      <h2>Recent index runs</h2>
      {jobs.length === 0 ? (
        <p className="settings-empty">None yet.</p>
      ) : (
        <div className="settings-table-wrap">
          <table className="settings-table">
            <thead>
              <tr><th>Repository</th><th>Trigger</th><th>Status</th><th>Commit</th><th>Result</th><th>Started</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.repoName}</td>
                  <td>{j.trigger}</td>
                  <td><StatusBadge job={j} /></td>
                  <td className="mono">{j.commitSha?.slice(0, 7) ?? "—"}</td>
                  <td className="settings-result">
                    {j.error ??
                      (j.stats?.unchanged
                        ? "no new commits"
                        : j.stats?.nodes !== undefined
                          ? `${j.stats.nodes} nodes · ${j.stats.edges} edges · ${j.stats.seconds}s`
                          : "")}
                  </td>
                  <td>{when(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Sign-ups (platform admins) ──────────────────────────────────────────────

function UsersSection({ users, busy, run }: { users: User[]; busy: string | null; run: Run }) {
  const done: Record<string, string> = {
    approve: "approved, with their own graph",
    suspend: "suspended and signed out",
    reactivate: "reactivated",
    reset_mfa: "2FA reset and signed out; they set it up again at next sign-in",
  };
  const act = (u: User, action: "approve" | "suspend" | "reactivate" | "reset_mfa") =>
    run(`user-${u.id}`, async () => {
      await api(`/api/admin/users/${u.id}`, { method: "POST", json: { action } });
      return `${u.githubLogin}: ${done[action]}.`;
    });
  return (
    <section className="settings-card">
      <h2>People</h2>
      <p className="settings-help">
        Everyone who has signed in with GitHub. Approving someone gives them their own,
        separate graph; suspending them stops their access on their next request.
      </p>
      {users.length === 0 ? (
        <p className="settings-empty">Nobody has signed in with GitHub yet.</p>
      ) : (
        <ul className="settings-list">
          {users.map((u) => (
            <li key={u.id} className="settings-row">
              <div className="settings-row-main">
                <b>{u.githubLogin}</b>
                <span className="muted">
                  {u.displayName ?? ""}{u.email ? ` · ${u.email}` : ""} · joined {when(u.createdAt)}
                  {u.tenant ? ` · graph ${u.tenant}` : ""}{u.isPlatformAdmin ? " · admin" : ""}
                </span>
                <span><span className={`badge badge-user-${u.status}`}>{u.status}</span></span>
              </div>
              <div className="settings-row-actions">
                {u.status === "pending" && (
                  <button className="primary" disabled={busy !== null} onClick={() => void act(u, "approve")}>Approve</button>
                )}
                {u.status === "active" && !u.isPlatformAdmin && (
                  <button className="danger" disabled={busy !== null} onClick={() => void act(u, "suspend")}>Suspend</button>
                )}
                {u.status === "suspended" && (
                  <button disabled={busy !== null} onClick={() => void act(u, "reactivate")}>Reactivate</button>
                )}
                {u.status === "active" && (
                  <button disabled={busy !== null} onClick={() => void act(u, "reset_mfa")}>Reset 2FA</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
