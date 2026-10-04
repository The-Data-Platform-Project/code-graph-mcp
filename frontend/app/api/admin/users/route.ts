import { listUsers } from "@/lib/accounts";
import { canAdminister } from "@/lib/access";
import { json, withViewer } from "@/lib/handler";

export const dynamic = "force-dynamic";

/** Everyone who has signed in with GitHub, pending first. Platform admins only. */
export const GET = withViewer(async (viewer) => {
  if (!canAdminister(viewer)) return json({ error: "not found" }, 404);
  const users = await listUsers();
  return json({
    users: users.map((u) => ({
      id: Number(u.id),
      githubLogin: u.github_login,
      displayName: u.display_name,
      email: u.email,
      avatarUrl: u.avatar_url,
      status: u.status,
      isPlatformAdmin: u.is_platform_admin,
      tenant: u.tenant,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
    })),
  });
});
