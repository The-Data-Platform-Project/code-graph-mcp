import { addConnection, listConnections, recentJobs } from "@/lib/accounts";
import { json, withViewer } from "@/lib/handler";
import { indexerConfigured, requestIndex, webhookUrl } from "@/lib/indexer";
import {
  BRANCH_RE, EXTERNAL_REPO_RE, REPO_NAME_RE, forbidUnlessManager, positiveId, readJson,
} from "@/lib/settings";

export const dynamic = "force-dynamic";

/** The tenant's connected repositories, each with its latest index run. */
export const GET = withViewer(async (viewer) => {
  const [connections, jobs] = await Promise.all([
    listConnections(viewer.tenant.id),
    recentJobs(viewer.tenant.id),
  ]);
  const configured = indexerConfigured();
  return json({
    connections,
    jobs,
    indexer: { configured, webhookUrl: configured ? webhookUrl() : null },
  });
});

/**
 * Connect a GitHub repository, read with one of the tenant's tokens, and
 * queue its first index run straight away when an indexer is deployed.
 */
export const POST = withViewer(async (viewer, request: Request) => {
  const denied = forbidUnlessManager(viewer);
  if (denied) return denied;
  const body = await readJson(request);
  const externalRepo = String(body.externalRepo ?? "").trim();
  const repoName = String(body.repoName ?? "").trim() || externalRepo.split("/")[1] || "";
  const branch = String(body.branch ?? "").trim() || null;
  const tokenId = body.tokenId == null || body.tokenId === "" ? null : positiveId(String(body.tokenId));

  if (!EXTERNAL_REPO_RE.test(externalRepo)) return json({ error: "expected owner/repository" }, 400);
  if (!REPO_NAME_RE.test(repoName)) {
    return json({ error: "graph name: letters, digits, '.', '_' or '-' (at most 100)" }, 400);
  }
  if (branch && !BRANCH_RE.test(branch)) return json({ error: "that is not a branch name" }, 400);
  if (body.tokenId != null && body.tokenId !== "" && !tokenId) {
    return json({ error: "no such token" }, 400);
  }

  try {
    await addConnection(viewer.tenant.id, {
      repoName, externalRepo, tokenId, branch,
      indexDaily: body.indexDaily !== false,
      indexOnPush: body.indexOnPush !== false,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") return json({ error: `"${repoName}" is already connected` }, 409);
    if (code === "23503") return json({ error: "no such token" }, 400);
    throw err;
  }
  const index = await requestIndex(viewer.tenant.id, repoName);
  return json({ ok: true, repoName, index }, 201);
});
