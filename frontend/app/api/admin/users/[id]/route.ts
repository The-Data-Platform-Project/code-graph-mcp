import { approveUser, setUserStatus } from "@/lib/accounts";
import { disableMfa } from "@/lib/mfa";
import { logAuthEvent } from "@/lib/authlog";
import { json, withAdmin } from "@/lib/handler";
import { revokeAllSessions } from "@/lib/sessions";
import { requestMeta } from "@/lib/signin";
import { positiveId, readJson } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Approve a sign-up (provisions their own tenant), suspend / reactivate an
 * account, or reset a user's 2FA. Suspension and 2FA reset end the person's
 * sessions at once. Platform admins with a 2FA-verified session only.
 */
export const POST = withAdmin(
  async (viewer, request: Request, { params }: { params: Promise<{ id: string }> }) => {
    const id = positiveId((await params).id);
    if (!id) return json({ error: "no such user" }, 404);
    const { action } = await readJson(request);
    if (id === viewer.userId && action === "suspend") {
      return json({ error: "you cannot suspend yourself" }, 400);
    }
    switch (action) {
      case "approve":
        await approveUser(id);
        return json({ ok: true });
      case "suspend":
      case "reactivate":
        if (!(await setUserStatus(id, action === "suspend" ? "suspended" : "active"))) {
          return json({ error: "approve the account first" }, 400);
        }
        // A suspension ends every session now, not when each next re-checks.
        if (action === "suspend") await revokeAllSessions(`user:${id}`);
        await logAuthEvent(`admin_${action}`, "info", viewer.sub, requestMeta(request).ipHash, { user: id });
        return json({ ok: true });
      case "reset_mfa":
        // For someone who lost both their device and their backup codes. Their
        // sessions end; they sign in with GitHub and set 2FA up again.
        await disableMfa(id);
        await revokeAllSessions(`user:${id}`);
        await logAuthEvent("admin_reset_mfa", "info", viewer.sub, requestMeta(request).ipHash, { user: id });
        return json({ ok: true });
      default:
        return json({ error: "action must be approve, suspend, reactivate or reset_mfa" }, 400);
    }
  },
);
