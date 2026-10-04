/**
 * The control-plane writes behind sign-up and /settings: users and their
 * memberships, a tenant's GitHub tokens, repo connections and index jobs.
 * DDL in src/code_graph/control.py.
 *
 * Every function that touches tenant data takes the tenant id from the
 * caller's Viewer — never from a request field — and filters on it, so one
 * tenant can never read or change another's rows.
 */
import "server-only";
import { githubTokenKeyHex } from "./env";
import { query, transaction } from "./pool";
import { openSealed, parseKey, seal, tokenAad } from "./secretbox";

// ── Users ───────────────────────────────────────────────────────────────────

export type UserStatus = "pending" | "active" | "suspended";

export type UserRow = {
  id: string;
  github_id: string;
  github_login: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  status: UserStatus;
  is_platform_admin: boolean;
  created_at: string;
  approved_at: string | null;
  last_login_at: string | null;
};

export type GithubProfile = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
};

/**
 * Record a GitHub sign-in. A new person starts 'pending'. The owner's login
 * (OWNER_GITHUB_LOGIN) is made active and a platform admin, and joins the
 * owner tenant, so the owner never waits on their own approval.
 */
export async function recordSignIn(
  profile: GithubProfile,
  owner: { tenantId: number } | null,
): Promise<UserRow> {
  return transaction(async (q) => {
    const [user] = await q<UserRow>(
      `INSERT INTO control.users
              (github_id, github_login, display_name, email, avatar_url, status,
               is_platform_admin, approved_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN now() END, now())
       ON CONFLICT (github_id) DO UPDATE SET
              github_login = EXCLUDED.github_login,
              display_name = EXCLUDED.display_name,
              email = COALESCE(EXCLUDED.email, control.users.email),
              avatar_url = EXCLUDED.avatar_url,
              last_login_at = now(),
              status = CASE WHEN $7 THEN 'active' ELSE control.users.status END,
              is_platform_admin = control.users.is_platform_admin OR $7
       RETURNING *`,
      [profile.id, profile.login, profile.name, profile.email, profile.avatarUrl,
       owner ? "active" : "pending", !!owner],
    );
    if (owner) {
      await q(
        `INSERT INTO control.members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [owner.tenantId, user.id],
      );
    }
    return user;
  });
}

export type Membership = { tenantId: number; slug: string; role: "owner" | "admin" | "member" };

/** The tenant a user signs in to: their own, if they have several. */
export async function primaryMembership(userId: number): Promise<Membership | null> {
  const rows = await query<{ tenant_id: string; slug: string; role: Membership["role"] }>(
    `SELECT m.tenant_id, t.slug, m.role
       FROM control.members m JOIN control.tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND t.status = 'active'
      ORDER BY (m.role = 'owner') DESC, m.tenant_id
      LIMIT 1`,
    [userId],
  );
  return rows[0] ? { tenantId: Number(rows[0].tenant_id), slug: rows[0].slug, role: rows[0].role } : null;
}

/**
 * The live state of a signed-in user for one tenant, read on every request so
 * a suspension or removed membership takes effect at once, not at cookie expiry.
 */
export async function userAccess(
  userId: number,
  tenantId: number,
): Promise<{ login: string; isPlatformAdmin: boolean; role: Membership["role"] } | null> {
  const rows = await query<{ github_login: string; is_platform_admin: boolean; role: Membership["role"] }>(
    `SELECT u.github_login, u.is_platform_admin, m.role
       FROM control.users u
       JOIN control.members m ON m.user_id = u.id AND m.tenant_id = $2
      WHERE u.id = $1 AND u.status = 'active'`,
    [userId, tenantId],
  );
  return rows[0]
    ? { login: rows[0].github_login, isPlatformAdmin: rows[0].is_platform_admin, role: rows[0].role }
    : null;
}

export async function listUsers(): Promise<(UserRow & { tenant: string | null })[]> {
  return query(
    `SELECT u.*, (SELECT t.slug FROM control.members m JOIN control.tenants t ON t.id = m.tenant_id
                   WHERE m.user_id = u.id ORDER BY (m.role = 'owner') DESC LIMIT 1) AS tenant
       FROM control.users u
      ORDER BY (u.status = 'pending') DESC, u.created_at DESC`,
  );
}

/**
 * Approve a sign-up: give the person their own tenant (schema `tenant_gh_<id>`,
 * named from the immutable GitHub id, never a display name) and make them its
 * owner. Provisioning goes through control.provision_tenant, the one function
 * allowed to create schemas.
 */
export async function approveUser(userId: number): Promise<void> {
  await transaction(async (q) => {
    const [user] = await q<{ github_id: string; github_login: string }>(
      `SELECT github_id, github_login FROM control.users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!user) throw new Error("no such user");
    const [{ id: tenantId }] = await q<{ id: string }>(
      `SELECT control.provision_tenant($1, $2) AS id`,
      [`gh_${user.github_id}`, user.github_login],
    );
    await q(
      `INSERT INTO control.members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [tenantId, userId],
    );
    await q(
      `UPDATE control.users SET status = 'active', approved_at = COALESCE(approved_at, now())
        WHERE id = $1`,
      [userId],
    );
  });
}

export async function setUserStatus(userId: number, status: "active" | "suspended"): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE control.users SET status = $2 WHERE id = $1 AND status <> 'pending' RETURNING id`,
    [userId, status],
  );
  return rows.length === 1;
}

// ── GitHub tokens ───────────────────────────────────────────────────────────

export type GithubTokenInfo = {
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

function key(): Buffer {
  return parseKey(githubTokenKeyHex());
}

export async function listGithubTokens(tenantId: number): Promise<GithubTokenInfo[]> {
  const rows = await query<{
    id: string; label: string; github_login: string; token_hint: string;
    expires_at: string | null; created_at: string; last_checked_at: string | null;
    last_error: string | null; connections: string;
  }>(
    `SELECT k.id, k.label, k.github_login, k.token_hint, k.expires_at, k.created_at,
            k.last_checked_at, k.last_error,
            (SELECT COUNT(*) FROM control.repo_connections c
              WHERE c.tenant_id = k.tenant_id AND c.github_token_id = k.id) AS connections
       FROM control.github_tokens k
      WHERE k.tenant_id = $1
      ORDER BY k.created_at`,
    [tenantId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    label: r.label,
    githubLogin: r.github_login,
    hint: r.token_hint,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    lastCheckedAt: r.last_checked_at,
    lastError: r.last_error,
    connections: Number(r.connections),
  }));
}

export async function addGithubToken(
  tenantId: number,
  userId: number | null,
  label: string,
  githubLogin: string,
  token: string,
  expiresAt: string | null,
): Promise<number> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO control.github_tokens
            (tenant_id, created_by, label, github_login, token_ciphertext, token_hint,
             expires_at, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING id`,
    [tenantId, userId, label, githubLogin, seal(key(), token, tokenAad(tenantId)),
     token.slice(-4), expiresAt],
  );
  return Number(row.id);
}

/** A token's plaintext, for a server-side GitHub call. Null if not this tenant's. */
export async function githubTokenPlain(tenantId: number, tokenId: number): Promise<string | null> {
  const rows = await query<{ token_ciphertext: string }>(
    `SELECT token_ciphertext FROM control.github_tokens WHERE id = $1 AND tenant_id = $2`,
    [tokenId, tenantId],
  );
  return rows[0] ? openSealed(key(), rows[0].token_ciphertext, tokenAad(tenantId)) : null;
}

/** Open a ciphertext read alongside a connection (lib/control.ts). */
export function openGithubToken(tenantId: number, ciphertext: string): string {
  return openSealed(key(), ciphertext, tokenAad(tenantId));
}

export async function recordTokenCheck(
  tenantId: number,
  tokenId: number,
  result: { error: string | null; expiresAt?: string | null },
): Promise<void> {
  await query(
    `UPDATE control.github_tokens
        SET last_checked_at = now(), last_error = $3,
            expires_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE expires_at END
      WHERE id = $1 AND tenant_id = $2`,
    [tokenId, tenantId, result.error, result.expiresAt !== undefined, result.expiresAt ?? null],
  );
}

export async function deleteGithubToken(tenantId: number, tokenId: number): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM control.github_tokens WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [tokenId, tenantId],
  );
  return rows.length === 1;
}

// ── Repo connections ────────────────────────────────────────────────────────

export type JobInfo = {
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

export type ConnectionInfo = {
  repoName: string;
  externalRepo: string;
  branch: string | null;
  gitRef: string | null;
  tokenId: number | null;
  tokenLabel: string | null;
  indexDaily: boolean;
  indexOnPush: boolean;
  lastIndexedAt: string | null;
  lastJob: JobInfo | null;
};

type JobRow = {
  id: string; repo_name: string; trigger: JobInfo["trigger"]; status: JobInfo["status"];
  commit_sha: string | null; error: string | null; stats: Record<string, unknown> | null;
  created_at: string; finished_at: string | null;
};

function toJob(r: JobRow): JobInfo {
  return {
    id: Number(r.id), repoName: r.repo_name, trigger: r.trigger, status: r.status,
    commitSha: r.commit_sha, error: r.error, stats: r.stats,
    createdAt: r.created_at, finishedAt: r.finished_at,
  };
}

export async function listConnections(tenantId: number): Promise<ConnectionInfo[]> {
  const rows = await query<{
    repo_name: string; external_repo: string; branch: string | null; git_ref: string | null;
    github_token_id: string | null; token_label: string | null; index_daily: boolean;
    index_on_push: boolean; last_indexed_at: string | null; job: JobRow | null;
  }>(
    `SELECT c.repo_name, c.external_repo, c.branch, c.git_ref, c.github_token_id,
            k.label AS token_label, c.index_daily, c.index_on_push, c.last_indexed_at,
            (SELECT row_to_json(j) FROM (
               SELECT id, repo_name, trigger, status, commit_sha, error, stats,
                      created_at, finished_at
                 FROM control.index_jobs
                WHERE tenant_id = c.tenant_id AND repo_name = c.repo_name
                ORDER BY created_at DESC LIMIT 1) j) AS job
       FROM control.repo_connections c
       LEFT JOIN control.github_tokens k
              ON k.id = c.github_token_id AND k.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1
      ORDER BY c.repo_name`,
    [tenantId],
  );
  return rows.map((r) => ({
    repoName: r.repo_name,
    externalRepo: r.external_repo,
    branch: r.branch,
    gitRef: r.git_ref,
    tokenId: r.github_token_id ? Number(r.github_token_id) : null,
    tokenLabel: r.token_label,
    indexDaily: r.index_daily,
    indexOnPush: r.index_on_push,
    lastIndexedAt: r.last_indexed_at,
    lastJob: r.job ? toJob(r.job) : null,
  }));
}

export type ConnectionInput = {
  repoName: string;
  externalRepo: string;
  tokenId: number | null;
  branch: string | null;
  indexDaily: boolean;
  indexOnPush: boolean;
};

export async function addConnection(tenantId: number, c: ConnectionInput): Promise<void> {
  // The composite foreign key refuses a token id from another tenant.
  await query(
    `INSERT INTO control.repo_connections
            (tenant_id, repo_name, provider, external_repo, github_token_id, branch,
             index_daily, index_on_push)
     VALUES ($1, $2, 'github', $3, $4, $5, $6, $7)`,
    [tenantId, c.repoName, c.externalRepo, c.tokenId, c.branch, c.indexDaily, c.indexOnPush],
  );
}

export async function updateConnection(
  tenantId: number,
  repoName: string,
  patch: Partial<Pick<ConnectionInput, "tokenId" | "branch" | "indexDaily" | "indexOnPush">>,
): Promise<boolean> {
  const rows = await query<{ repo_name: string }>(
    `UPDATE control.repo_connections SET
            github_token_id = CASE WHEN $3::boolean THEN $4::bigint ELSE github_token_id END,
            branch          = CASE WHEN $5::boolean THEN $6::text ELSE branch END,
            index_daily     = COALESCE($7::boolean, index_daily),
            index_on_push   = COALESCE($8::boolean, index_on_push)
      WHERE tenant_id = $1 AND repo_name = $2
      RETURNING repo_name`,
    [tenantId, repoName,
     patch.tokenId !== undefined, patch.tokenId ?? null,
     patch.branch !== undefined, patch.branch ?? null,
     patch.indexDaily ?? null, patch.indexOnPush ?? null],
  );
  return rows.length === 1;
}

export async function deleteConnection(tenantId: number, repoName: string): Promise<boolean> {
  const rows = await query<{ repo_name: string }>(
    `DELETE FROM control.repo_connections WHERE tenant_id = $1 AND repo_name = $2
     RETURNING repo_name`,
    [tenantId, repoName],
  );
  return rows.length === 1;
}

export async function connectionTokenId(tenantId: number, repoName: string): Promise<{
  externalRepo: string;
  tokenId: number | null;
} | null> {
  const rows = await query<{ external_repo: string; github_token_id: string | null }>(
    `SELECT external_repo, github_token_id FROM control.repo_connections
      WHERE tenant_id = $1 AND repo_name = $2`,
    [tenantId, repoName],
  );
  return rows[0]
    ? { externalRepo: rows[0].external_repo, tokenId: rows[0].github_token_id ? Number(rows[0].github_token_id) : null }
    : null;
}

export async function recentJobs(tenantId: number, limit = 25): Promise<JobInfo[]> {
  const rows = await query<JobRow>(
    `SELECT id, repo_name, trigger, status, commit_sha, error, stats, created_at, finished_at
       FROM control.index_jobs WHERE tenant_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows.map(toJob);
}
