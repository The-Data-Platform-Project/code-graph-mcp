import { addGithubToken, listGithubTokens } from "@/lib/accounts";
import { FINE_GRAINED_PREFIX, GitHubError, inspectToken } from "@/lib/github";
import { json, withViewer } from "@/lib/handler";
import { forbidUnlessManager, readJson } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** The tenant's GitHub tokens: labels, owners, expiry. Never the tokens themselves. */
export const GET = withViewer(async (viewer) => {
  return json({ tokens: await listGithubTokens(viewer.tenant.id) });
});

/**
 * Add a fine-grained token. It is checked against GitHub before it is kept:
 * it must be fine-grained (scoped to chosen repositories, unlike a classic
 * token), GitHub must accept it, and it must belong to the person adding it,
 * so nobody can park someone else's leaked token in their tenant.
 */
export const POST = withViewer(async (viewer, request: Request) => {
  const denied = forbidUnlessManager(viewer);
  if (denied) return denied;
  const body = await readJson(request);
  const token = String(body.token ?? "").trim();
  const label = String(body.label ?? "").trim().slice(0, 80);
  if (!label) return json({ error: "give the token a label" }, 400);
  if (!token.startsWith(FINE_GRAINED_PREFIX) || !/^[A-Za-z0-9_]{40,255}$/.test(token)) {
    return json(
      { error: "that is not a fine-grained token (they start with github_pat_)" },
      400,
    );
  }
  try {
    const identity = await inspectToken(token);
    if (viewer.githubLogin && identity.login.toLowerCase() !== viewer.githubLogin.toLowerCase()) {
      return json(
        { error: `that token belongs to ${identity.login}, not to you (${viewer.githubLogin})` },
        400,
      );
    }
    const id = await addGithubToken(
      viewer.tenant.id, viewer.userId, label, identity.login, token, identity.expiresAt,
    );
    return json({ id, githubLogin: identity.login, expiresAt: identity.expiresAt }, 201);
  } catch (err) {
    if (err instanceof GitHubError) return json({ error: err.message }, 400);
    throw err;
  }
});
