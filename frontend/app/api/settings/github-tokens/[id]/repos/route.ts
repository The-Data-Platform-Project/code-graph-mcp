import { githubTokenPlain } from "@/lib/accounts";
import { GitHubError, listTokenRepos } from "@/lib/github";
import { json, withViewer } from "@/lib/handler";
import { positiveId } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** The repositories this token was granted on GitHub: what can be connected with it. */
export const GET = withViewer(
  async (viewer, _request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const id = positiveId((await params).id);
    const token = id ? await githubTokenPlain(viewer.tenant.id, id) : null;
    if (!token) return json({ error: "no such token" }, 404);
    try {
      return json({ repos: await listTokenRepos(token) });
    } catch (err) {
      if (err instanceof GitHubError) return json({ error: err.message }, 502);
      throw err;
    }
  },
);
