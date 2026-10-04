import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { ownerPassword, ownerTenantSlug, sessionSecret } from "@/lib/env";
import { DEFAULT_TARGET, safeTarget, seeOther, signedIn } from "@/lib/signin";

export const dynamic = "force-dynamic";

function sameSecret(a: string, b: string): boolean {
  // Hash first so the comparison is over equal-length buffers and runs in
  // constant time regardless of how long the guess is.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Owner login: one shared password. A break-glass path next to sign-in with
 * GitHub; unset OWNER_PASSWORD once the owner signs in with OWNER_GITHUB_LOGIN.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const password = String(form?.get("password") ?? "");
  // After signing in, the explorer — "/" is the public landing page now.
  const target = safeTarget(String(form?.get("next") ?? DEFAULT_TARGET));
  const back = (error: string) => {
    const params = new URLSearchParams({ error });
    if (target !== DEFAULT_TARGET) params.set("next", target);
    return seeOther(`/login?${params}`);
  };

  // A deployment without (or with too weak) sign-in settings — a preview
  // without OWNER_PASSWORD, say — must answer with a page, not a 500. The
  // reason goes to the server log; the visitor only learns sign-in is off.
  let expected: string;
  try {
    expected = ownerPassword();
    sessionSecret();
  } catch (err) {
    console.error("sign-in is not configured:", err instanceof Error ? err.message : err);
    return back("config");
  }

  if (!password || !sameSecret(password, expected)) {
    // A fixed delay makes guessing slow without keeping any state.
    await new Promise((r) => setTimeout(r, 600));
    return back("1");
  }

  return signedIn(target, { sub: "owner", tenant: ownerTenantSlug(), role: "owner" });
}
