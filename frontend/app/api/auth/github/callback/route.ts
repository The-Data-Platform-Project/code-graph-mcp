import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { primaryMembership, recordSignIn, type GithubProfile } from "@/lib/accounts";
import { tenantBySlug } from "@/lib/control";
import { githubOAuth, ownerGithubLogin, ownerTenantSlug, publicAppUrl } from "@/lib/env";
import { ghFetch } from "@/lib/github";
import { OAUTH_COOKIE, safeTarget, seeOther, signedIn } from "@/lib/signin";

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
 * GitHub sends the browser back here with a one-time code. Exchange it, read
 * who the person is, and then forget the OAuth token: it is never stored, and
 * it could not read a repository anyway.
 *
 * New people are recorded as pending and told so; the owner approves them in
 * /settings. An approved person gets a session for their own tenant.
 */
export async function GET(request: NextRequest) {
  const oauth = githubOAuth();
  if (!oauth) return failed("config");

  let saved: { state?: string; next?: string } = {};
  try {
    saved = JSON.parse(request.cookies.get(OAUTH_COOKIE)?.value ?? "{}");
  } catch {
    saved = {};
  }
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  if (params.get("error") === "access_denied") return failed("github_denied");
  if (!code || !sameState(params.get("state") ?? "", saved.state ?? "")) return failed("github_state");

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
  if (!accessToken) return failed("github_exchange");

  const profile = await profileFrom(accessToken);
  if (!profile) return failed("github_exchange");

  const isOwner = !!ownerGithubLogin() && profile.login.toLowerCase() === ownerGithubLogin();
  const ownerTenant = isOwner ? await tenantBySlug(ownerTenantSlug()) : null;
  const user = await recordSignIn(profile, ownerTenant ? { tenantId: ownerTenant.id } : null);

  if (user.status === "suspended") return failed("suspended");
  const membership = user.status === "active" ? await primaryMembership(Number(user.id)) : null;
  if (!membership) {
    const res = seeOther(`/login?status=pending&who=${encodeURIComponent(profile.login)}`);
    res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth/github", maxAge: 0 });
    return res;
  }

  const res = await signedIn(safeTarget(saved.next), {
    sub: `user:${user.id}`,
    tenant: membership.slug,
    role: membership.role,
  });
  res.cookies.set(OAUTH_COOKIE, "", { path: "/api/auth/github", maxAge: 0 });
  return res;
}
