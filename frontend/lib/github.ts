/**
 * The GitHub REST calls the app makes with a tenant's fine-grained token:
 * who the token belongs to, which repositories it can see, and registering the
 * indexer's push webhook. Server-side only; tokens never reach a browser.
 */
import "server-only";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export async function ghFetch(path: string, token: string | null, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "code-graph",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    return await fetch(`${API}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GitHubError(`could not reach GitHub: ${err instanceof Error ? err.message : err}`);
  }
}

/** Fine-grained tokens only: they are scoped to chosen repositories. */
export const FINE_GRAINED_PREFIX = "github_pat_";

export type TokenIdentity = { login: string; expiresAt: string | null };

/** Who a token acts as and when it expires; throws if GitHub rejects it. */
export async function inspectToken(token: string): Promise<TokenIdentity> {
  const res = await ghFetch("/user", token);
  if (res.status === 401) throw new GitHubError("GitHub rejected the token (expired, revoked or mistyped)", 401);
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status} checking the token`, res.status);
  const user = (await res.json()) as { login: string };
  // e.g. "2026-11-03 12:00:00 UTC"; absent for tokens without an expiry.
  const header = res.headers.get("github-authentication-token-expiration");
  const parsed = header ? new Date(header.replace(" UTC", "Z").replace(" ", "T")) : null;
  return {
    login: user.login,
    expiresAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
  };
}

export type TokenRepo = {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canAdmin: boolean;
};

/**
 * The repositories a token can read. For a fine-grained token, GitHub answers
 * with exactly the repositories selected when it was created.
 */
export async function listTokenRepos(token: string, maxPages = 5): Promise<TokenRepo[]> {
  const out: TokenRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await ghFetch(`/user/repos?per_page=100&sort=full_name&page=${page}`, token);
    if (!res.ok) throw new GitHubError(`GitHub returned ${res.status} listing repositories`, res.status);
    const rows = (await res.json()) as {
      full_name: string;
      private: boolean;
      default_branch: string;
      permissions?: { admin?: boolean };
    }[];
    for (const r of rows) {
      out.push({
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        canAdmin: !!r.permissions?.admin,
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

/**
 * Register the indexer's push webhook on a repository. Needs the token's
 * "Webhooks: read and write" permission; returns a reason when it cannot.
 */
export async function createPushWebhook(
  token: string,
  externalRepo: string,
  url: string,
  secret: string,
): Promise<{ ok: true; existed: boolean } | { ok: false; reason: string }> {
  const res = await ghFetch(`/repos/${externalRepo}/hooks`, token, {
    method: "POST",
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: { url, content_type: "json", secret, insecure_ssl: "0" },
    }),
  });
  if (res.ok) return { ok: true, existed: false };
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { errors?: { message?: string }[] };
    if (body.errors?.some((e) => /already exists/i.test(e.message ?? ""))) {
      return { ok: true, existed: true };
    }
    return { ok: false, reason: "GitHub refused the webhook settings" };
  }
  if (res.status === 403 || res.status === 404) {
    return {
      ok: false,
      reason: "the token lacks the Webhooks (read and write) permission on this repository",
    };
  }
  return { ok: false, reason: `GitHub returned ${res.status}` };
}
