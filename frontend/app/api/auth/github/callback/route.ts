import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { primaryMembership, recordSignIn, tenantAdminGithubIds, type GithubProfile } from "@/lib/accounts";
import { logAuthEvent } from "@/lib/authlog";
import { OAUTH_PER_IP } from "@/lib/authpolicy";
import { tenantBySlug } from "@/lib/control";
import { githubOAuth, ownerGithubId, ownerGithubLogin, ownerTenantSlug, publicAppUrl } from "@/lib/env";
import type { Tenant } from "@/lib/tenancy";
import { ghFetch } from "@/lib/github";
import { mfaEnabled } from "@/lib/mfa";
import { consume } from "@/lib/ratelimit";
import { OAUTH_COOKIE, bouncePage, requestMeta, safeTarget, seeOther, startSession } from "@/lib/signin";

export const dynamic = "force-dynamic";

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function failed(reason: string) {
  const res = seeOther(`/login?error=${encodeURIComponent(reason)}`);
  res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth/github", maxAge: 0 });
  return res;
}

/** The person's GitHub identity, from the short-lived OAuth token. */
async function profileFrom(accessToken: string): Promise<GithubProfile | null> {
  const res = await ghFetch("/user", accessToken);
  if (!res.ok) return null;
  const u = (await res.json()) as {
    id: number; login: string; name: string | null; email: string | null; avatar_url: string | null;
  };
  let email = u.email;
  if (!email) {
    const emails = await ghFetch("/user/emails", accessToken);
    if (emails.ok) {
      const list = (await emails.json()) as { email: string; primary: boolean; verified: boolean }[];
      email = list.find((e) => e.primary && e.verified)?.email ?? null;
    }
  }
  return { id: u.id, login: u.login, name: u.name, email, avatarUrl: u.avatar_url };
}

/**
 * The owner tenant, if this GitHub account is the owner. OWNER_GITHUB_ID (the
 * immutable numeric id) decides when set. With only OWNER_GITHUB_LOGIN, the
 * first account to sign in under that login is pinned: a later, different
 * account holding the same login (renamed and re-registered) is not the owner.
 */
async function ownerTenantFor(profile: GithubProfile): Promise<Tenant | null> {
  const id = ownerGithubId();
  const login = ownerGithubLogin();
  const matches = id !== null ? profile.id === id : !!login && profile.login.toLowerCase() === login;
  if (!matches) return null;
  const tenant = await tenantBySlug(ownerTenantSlug());
  if (!tenant || id !== null) return tenant;
  const pinned = await tenantAdminGithubIds(tenant.id);
  if (pinned.length && !pinned.includes(profile.id)) {
    console.error(`GitHub account ${profile.id} holds OWNER_GITHUB_LOGIN but is not the pinned owner; not granted.`);
    return null;
  }
  return tenant;
}

/**
 * GitHub sends the browser back here with a one-time code. Exchange it, read
 * who the person is, and then forget the OAuth token: it is never stored, and
 * it could not read a repository anyway.
 *
 * New people are recorded as pending and told so; the owner approves them in
 * /settings. An approved person gets a session for their own tenant; one who
 * has turned on 2FA gets a pending session and is sent to enter their code.
 *
 * The answer is a same-origin bounce page, not a redirect: the session cookie
 * is SameSite=Strict and would not ride the rest of GitHub's redirect chain.
 * Rate limited per IP (10 per 15 minutes); every outcome is logged.
 */
export async function GET(request: NextRequest) {
  const oauth = githubOAuth();
  if (!oauth) return failed("config");

  const meta = requestMeta(request);
  const rate = await consume(`oauth-callback:ip:${meta.ipHash}`, OAUTH_PER_IP);
  if (!rate.allowed) {
    await logAuthEvent("github_callback", "blocked", null, meta.ipHash, { reason: "rate_limit" });
    return failed("rate");
  }

  let saved: { state?: string; next?: string } = {};
  try {
    saved = JSON.parse(request.cookies.get(OAUTH_COOKIE)?.value ?? "{}");
  } catch {
    saved = {};
  }
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  if (params.get("error") === "access_denied") return failed("github_denied");
  if (!code || !sameState(params.get("state") ?? "", saved.state ?? "")) {
    await logAuthEvent("github_callback", "failure", null, meta.ipHash, { reason: "state_mismatch" });
    return failed("github_state");
  }

  const origin = publicAppUrl() || request.nextUrl.origin;
  let accessToken = "";
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: `${origin}/api/auth/github/callback`,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    accessToken = ((await res.json()) as { access_token?: string }).access_token ?? "";
  } catch (err) {
    console.error("GitHub token exchange failed:", err instanceof Error ? err.message : err);
  }
  if (!accessToken) {
    await logAuthEvent("github_callback", "failure", null, meta.ipHash, { reason: "code_exchange" });
    return failed("github_exchange");
  }

  const profile = await profileFrom(accessToken);
  if (!profile) {
    await logAuthEvent("github_callback", "failure", null, meta.ipHash, { reason: "profile" });
    return failed("github_exchange");
  }

  const ownerTenant = await ownerTenantFor(profile);
  const user = await recordSignIn(profile, ownerTenant ? { tenantId: ownerTenant.id } : null);

  const subject = `user:${user.id}`;
  if (user.status === "suspended") {
    await logAuthEvent("github_sign_in", "blocked", subject, meta.ipHash, { reason: "suspended" });
    return failed("suspended");
  }
  const membership = user.status === "active" ? await primaryMembership(Number(user.id)) : null;
  if (!membership) {
    await logAuthEvent("github_sign_in", "info", subject, meta.ipHash, { reason: "pending_approval" });
    const res = seeOther(`/login?status=pending&who=${encodeURIComponent(profile.login)}`);
    res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth/github", maxAge: 0 });
    return res;
  }

  const target = safeTarget(saved.next);
  const needsCode = await mfaEnabled(Number(user.id));
  await logAuthEvent("github_sign_in", "success", subject, meta.ipHash, { step: needsCode ? "github" : "complete" });
  const res = await startSession(
    request,
    {
      sub: subject,
      userId: Number(user.id),
      tenant: membership.slug,
      role: membership.role,
      mfa: needsCode ? "pending" : "none",
    },
    bouncePage(needsCode ? `/login/verify?next=${encodeURIComponent(target)}` : target),
  );
  res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth/github", maxAge: 0 });
  return res;
}
