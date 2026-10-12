/**
 * The control plane: tenants, MCP tokens and repo connections, in the
 * `control` schema. See src/code_graph/control.py for the DDL.
 */
import { createHash } from "node:crypto";
import { query } from "./pool";
import type { Tenant } from "./tenancy";

type TenantRow = {
  id: string;
  slug: string;
  schema_name: string;
  display_name: string;
};

function toTenant(row: TenantRow): Tenant {
  return {
    id: Number(row.id),
    slug: row.slug,
    schema: row.schema_name,
    displayName: row.display_name,
  };
}

// Tenants change rarely and are read on every request, so cache them briefly.
const TTL_MS = 60_000;
const bySlug = new Map<string, { tenant: Tenant | null; at: number }>();

export async function tenantBySlug(slug: string): Promise<Tenant | null> {
  const hit = bySlug.get(slug);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tenant;
  const rows = await query<TenantRow>(
    `SELECT id, slug, schema_name, display_name
       FROM control.tenants
      WHERE slug = $1 AND status = 'active'`,
    [slug],
  );
  const tenant = rows[0] ? toTenant(rows[0]) : null;
  bySlug.set(slug, { tenant, at: Date.now() });
  return tenant;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Resolve an MCP bearer token to the one tenant it grants. Revoked tokens and
 * suspended tenants resolve to nothing.
 */
export async function tenantByToken(raw: string): Promise<Tenant | null> {
  if (!raw) return null;
  const rows = await query<TenantRow & { token_id: string }>(
    `SELECT t.id, t.slug, t.schema_name, t.display_name, k.id AS token_id
       FROM control.mcp_tokens k
       JOIN control.tenants t ON t.id = k.tenant_id
      WHERE k.token_hash = $1
        AND k.revoked_at IS NULL
        AND t.status = 'active'`,
    [hashToken(raw)],
  );
  if (!rows[0]) return null;
  // Record use, at most once a minute per token, so this is not a write on
  // every tool call.
  void query(
    `UPDATE control.mcp_tokens SET last_used_at = now()
      WHERE id = $1
        AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [rows[0].token_id],
  ).catch(() => {});
  return toTenant(rows[0]);
}

export type RepoConnection = {
  provider: "github";
  externalRepo: string;
  gitRef: string | null;
  /** The sealed fine-grained token that reads this repo (lib/secretbox.ts), if any. */
  tokenCiphertext: string | null;
};

/**
 * Where a tenant's repository comes from. The browser only ever names a repo
 * *within its own tenant*; the GitHub repo and the token that reads it are
 * looked up here, so nobody can point a token at a repository their tenant
 * does not own.
 */
export async function repoConnection(
  tenantId: number,
  repoName: string,
): Promise<RepoConnection | null> {
  const rows = await query<{
    provider: "github";
    external_repo: string;
    git_ref: string | null;
    token_ciphertext: string | null;
  }>(
    `SELECT c.provider, c.external_repo, c.git_ref, k.token_ciphertext
       FROM control.repo_connections c
       LEFT JOIN control.github_tokens k
              ON k.id = c.github_token_id AND k.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.repo_name = $2`,
    [tenantId, repoName],
  );
  return rows[0]
    ? {
        provider: rows[0].provider,
        externalRepo: rows[0].external_repo,
        gitRef: rows[0].git_ref,
        tokenCiphertext: rows[0].token_ciphertext,
      }
    : null;
}
