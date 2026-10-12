/**
 * Whether OWNER_PASSWORD may be used at all, checked once per process (and
 * again whenever the value changes): the policy in lib/password-policy.ts plus
 * Have I Been Pwned. A password that fails is refused for every login and the
 * reason goes to the server log, never to the visitor.
 */
import "server-only";
import { createHash } from "node:crypto";
import { COMMON_PASSWORDS } from "./common-passwords";
import { evaluatePassword, pwnedCount } from "./password-policy";

let cached: { digest: string; problem: string | null } | null = null;

export async function ownerPasswordProblem(password: string): Promise<string | null> {
  const digest = createHash("sha256").update(password).digest("hex");
  if (cached?.digest === digest) return cached.problem;
  const verdict = evaluatePassword(password, COMMON_PASSWORDS, ["owner", "contextforge", "codegraph", "admin"]);
  let problem: string | null = verdict.ok ? null : `OWNER_PASSWORD is too weak: ${verdict.problems.join(" ")}`;
  if (!problem) {
    const seen = await pwnedCount(password);
    if (seen === null) {
      // Availability over certainty: an outage at HIBP must not lock the owner
      // out. Not cached, so the next login checks again.
      console.warn("Have I Been Pwned unreachable; OWNER_PASSWORD breach check skipped this time.");
      return null;
    }
    if (seen > 0) problem = `OWNER_PASSWORD appears in ${seen} known data breaches (Have I Been Pwned).`;
  }
  cached = { digest, problem };
  return problem;
}
