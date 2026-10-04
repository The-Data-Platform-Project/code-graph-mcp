import { deleteGithubToken, githubTokenPlain, recordTokenCheck } from "@/lib/accounts";
import { GitHubError, inspectToken } from "@/lib/github";
import { json, withViewer } from "@/lib/handler";
import { forbidUnlessManager, positiveId } from "@/lib/settings";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Re-check a token with GitHub (still valid? new expiry?). */
export const POST = withViewer(async (viewer, _request: Request, { params }: Ctx) => {
  const denied = forbidUnlessManager(viewer);
  if (denied) return denied;
  const id = positiveId((await params).id);
  const token = id ? await githubTokenPlain(viewer.tenant.id, id) : null;
  if (!id || !token) return json({ error: "no such token" }, 404);
  try {
    const identity = await inspectToken(token);
    await recordTokenCheck(viewer.tenant.id, id, { error: null, expiresAt: identity.expiresAt });
    return json({ ok: true, githubLogin: identity.login, expiresAt: identity.expiresAt });
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    await recordTokenCheck(viewer.tenant.id, id, { error: err.message });
    return json({ ok: false, error: err.message });
  }
});

/** Forget a token. Connections that used it keep working for public repos only. */
export const DELETE = withViewer(async (viewer, _request: Request, { params }: Ctx) => {
  const denied = forbidUnlessManager(viewer);
  if (denied) return denied;
  const id = positiveId((await params).id);
  if (!id || !(await deleteGithubToken(viewer.tenant.id, id))) {
    return json({ error: "no such token" }, 404);
  }
  return json({ ok: true });
});
