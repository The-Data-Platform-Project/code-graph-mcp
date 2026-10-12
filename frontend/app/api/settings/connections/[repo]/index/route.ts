import { connectionTokenId } from "@/lib/accounts";
import { json, withViewer } from "@/lib/handler";
import { requestIndex } from "@/lib/indexer";
import { REPO_NAME_RE, forbidUnlessManager } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** "Index now": queue a run of the latest commit, even if it was indexed before. */
export const POST = withViewer(
  async (viewer, _request: Request, { params }: { params: Promise<{ repo: string }> }) => {
    const denied = forbidUnlessManager(viewer);
    if (denied) return denied;
    const repoName = decodeURIComponent((await params).repo);
    if (!REPO_NAME_RE.test(repoName) || !(await connectionTokenId(viewer.tenant.id, repoName))) {
      return json({ error: "no such connection" }, 404);
    }
    const result = await requestIndex(viewer.tenant.id, repoName);
    return json(result, result.ok ? 202 : 503);
  },
);
