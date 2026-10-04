import { approveUser, setUserStatus } from "@/lib/accounts";
import { canAdminister } from "@/lib/access";
import { json, withViewer } from "@/lib/handler";
import { positiveId, readJson } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Approve a sign-up (provisions their own tenant), or suspend / reactivate an
 * account. A suspension takes effect on the person's next request.
 */
export const POST = withViewer(
  async (viewer, request: Request, { params }: { params: Promise<{ id: string }> }) => {
    if (!canAdminister(viewer)) return json({ error: "not found" }, 404);
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
        return json({ ok: true });
      default:
        return json({ error: "action must be approve, suspend or reactivate" }, 400);
    }
  },
);
