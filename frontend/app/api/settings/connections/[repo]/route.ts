import { deleteConnection, updateConnection } from "@/lib/accounts";
import { json, withViewer } from "@/lib/handler";
import { BRANCH_RE, REPO_NAME_RE, forbidUnlessManager, positiveId, readJson } from "@/lib/settings";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ repo: string }> };

/** Change a connection's token, branch, or when it is indexed. */
export const PATCH = withViewer(async (viewer, request: Request, { params }: Ctx) => {
  const denied = forbidUnlessManager(viewer);
  if (denied) return denied;
  const repoName = decodeURIComponent((await params).repo);
  if (!REPO_NAME_RE.test(repoName)) return json({ error: "no such connection" }, 404);
  const body = await readJson(request);

  const patch: Parameters<typeof updateConnection>[2] = {};
  if ("tokenId" in body) {
    patch.tokenId = body.tokenId == null || body.tokenId === "" ? null : positiveId(String(body.tokenId));
    if (body.tokenId != null && body.tokenId !== "" && !patch.tokenId) {
      return json({ error: "no such token" }, 400);
    }
  }
  if ("branch" in body) {
    const branch = String(body.branch ?? "").trim() || null;
    if (branch && !BRANCH_RE.test(branch)) return json({ error: "that is not a branch name" }, 400);
    patch.branch = branch;
  }
  if (typeof body.indexDaily === "boolean") patch.indexDaily = body.indexDaily;
  if (typeof body.indexOnPush === "boolean") patch.indexOnPush = body.indexOnPush;

  try {
    if (!(await updateConnection(viewer.tenant.id, repoName, patch))) {
      return json({ error: "no such connection" }, 404);
    }
  } catch (err) {
    if ((err as { code?: string }).code === "23503") return json({ error: "no such token" }, 400);
    throw err;
  }
  return json({ ok: true });
});

/**
 * Disconnect: no more index runs or previews for it. The graph already built
 * stays readable until an administrator removes it (the app's database role
 * cannot write graph tables).
 */
export const DELETE = withViewer(async (viewer, _request: Request, { params }: Ctx) => {
  const denied = forbidUnlessManager(viewer);
  if (denied) return denied;
  const repoName = decodeURIComponent((await params).repo);
  if (!REPO_NAME_RE.test(repoName) || !(await deleteConnection(viewer.tenant.id, repoName))) {
    return json({ error: "no such connection" }, 404);
  }
  return json({ ok: true });
});
