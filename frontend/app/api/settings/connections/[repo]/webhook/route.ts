import { connectionTokenId, githubTokenPlain } from "@/lib/accounts";
import { GitHubError, createPushWebhook } from "@/lib/github";
import { json, withViewer } from "@/lib/handler";
import { indexerConfigured, webhookSecret, webhookUrl } from "@/lib/indexer";
import { REPO_NAME_RE, forbidUnlessManager } from "@/lib/settings";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ repo: string }> };

async function resolve(viewer: Parameters<Parameters<typeof withViewer>[0]>[0], ctx: Ctx) {
  const repoName = decodeURIComponent((await ctx.params).repo);
  if (!REPO_NAME_RE.test(repoName)) return null;
  const conn = await connectionTokenId(viewer.tenant.id, repoName);
  return conn ? { repoName, ...conn } : null;
}

/**
 * What to enter on GitHub to add the push webhook by hand: the payload URL and
 * this connection's own secret (derived, so nothing is stored; it only ever
 * authorizes runs of this one connection).
 */
export const GET = withViewer(async (viewer, _request: Request, ctx: Ctx) => {
  const denied = forbidUnlessManager(viewer);
  if (denied) return denied;
  if (!indexerConfigured()) return json({ error: "no indexer is deployed" }, 503);
  const conn = await resolve(viewer, ctx);
  if (!conn) return json({ error: "no such connection" }, 404);
  return json({
    url: webhookUrl(),
    contentType: "application/json",
    secret: webhookSecret(viewer.tenant.id, conn.repoName),
    events: ["push"],
    settingsUrl: `https://github.com/${conn.externalRepo}/settings/hooks/new`,
  });
});

/** Register the webhook on GitHub with the connection's token, if it may. */
export const POST = withViewer(async (viewer, _request: Request, ctx: Ctx) => {
  const denied = forbidUnlessManager(viewer);
  if (denied) return denied;
  if (!indexerConfigured()) return json({ error: "no indexer is deployed" }, 503);
  const conn = await resolve(viewer, ctx);
  if (!conn) return json({ error: "no such connection" }, 404);
  const token = conn.tokenId ? await githubTokenPlain(viewer.tenant.id, conn.tokenId) : null;
  if (!token) return json({ ok: false, reason: "the connection has no token; add the webhook by hand" });
  try {
    return json(
      await createPushWebhook(token, conn.externalRepo, webhookUrl(),
        webhookSecret(viewer.tenant.id, conn.repoName)),
    );
  } catch (err) {
    if (err instanceof GitHubError) return json({ ok: false, reason: err.message });
    throw err;
  }
});
