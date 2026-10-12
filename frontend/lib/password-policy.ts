/**
 * Password strength, enforced on the server. Shared with
 * scripts/check-password.mts, which gives the same verdict and live feedback
 * when choosing a password.
 *
 * A password passes only if it:
 *   - has at least 12 characters (and at most 256),
 *   - mixes upper case, lower case, a digit and a symbol,
 *   - is not one of the 10,000 most common passwords, nor one with only digits
 *     or symbols added (password123!, Password2024),
 *   - scores at least 3 of 4 on zxcvbn (guessing resistance, which catches
 *     keyboard walks, dates, repeats and dictionary words),
 *   - and (checked separately, needs the network) is not in Have I Been Pwned.
 */
import { createHash } from "node:crypto";
import { zxcvbn, zxcvbnOptions } from "@zxcvbn-ts/core";
import * as zxcvbnCommon from "@zxcvbn-ts/language-common";
import * as zxcvbnEn from "@zxcvbn-ts/language-en";

zxcvbnOptions.setOptions({
  dictionary: { ...zxcvbnCommon.dictionary, ...zxcvbnEn.dictionary },
  graphs: zxcvbnCommon.adjacencyGraphs,
  translations: zxcvbnEn.translations,
});

export const MIN_LENGTH = 12;
export const MIN_SCORE = 3;

export type PasswordVerdict = {
  ok: boolean;
  score: number; // zxcvbn 0..4
  problems: string[];
  suggestions: string[];
};

export function evaluatePassword(password: string, common: Set<string>, userInputs: string[] = []): PasswordVerdict {
  const problems: string[] = [];
  if (password.length < MIN_LENGTH) problems.push(`Use at least ${MIN_LENGTH} characters.`);
  if (password.length > 256) problems.push("Use at most 256 characters.");
  if (!/[a-z]/.test(password)) problems.push("Add a lower-case letter.");
  if (!/[A-Z]/.test(password)) problems.push("Add an upper-case letter.");
  if (!/[0-9]/.test(password)) problems.push("Add a digit.");
  if (!/[^A-Za-z0-9]/.test(password)) problems.push("Add a symbol.");
  const lower = password.toLowerCase();
  const stripped = lower.replace(/[^a-z]+$/g, "").replace(/^[^a-z]+/g, "");
  if (common.has(lower) || (stripped.length >= 4 && common.has(stripped)) || common.has(lower.replace(/[^a-z0-9]/g, ""))) {
    problems.push("This is one of the most common passwords, or one with only digits or symbols added.");
  }
  const result = zxcvbn(password.slice(0, 256), userInputs);
  if (result.score < MIN_SCORE) problems.push("Too easy to guess: make it longer and less predictable.");
  return {
    ok: problems.length === 0,
    score: result.score,
    problems,
    suggestions: [result.feedback.warning ?? "", ...(result.feedback.suggestions ?? [])].filter(Boolean) as string[],
  };
}

/**
 * How many times Have I Been Pwned has seen this password, or null if the
 * service could not be reached. Uses the k-anonymity range API: only the first
 * five hex characters of the SHA-1 leave this server, with padding on.
 */
export async function pwnedCount(password: string): Promise<number | null> {
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      headers: { "Add-Padding": "true", "User-Agent": "contextforge-password-check" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const suffix = sha1.slice(5);
    for (const line of (await res.text()).split("\n")) {
      const [hash, count] = line.trim().split(":");
      if (hash === suffix) return Number(count) || 0;
    }
    return 0;
  } catch {
    return null;
  }
}
