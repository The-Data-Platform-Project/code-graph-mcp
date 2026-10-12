/** Post-sign-in redirects. Pure, so tests/auth.test.mts can exercise it. */

export const DEFAULT_TARGET = "/graph";

/**
 * Only same-origin paths, so sign-in cannot be used as an open redirect.
 * Control characters and whitespace are refused outright (browsers strip tabs
 * and newlines from URLs, so "/\t/evil.example" would become "//evil.example"),
 * and the value must still resolve to this origin when parsed as a URL.
 */
export function safeTarget(next: string | null | undefined): string {
  const value = next ?? "";
  if (!value.startsWith("/") || /[\x00-\x20\x7f\\]/.test(value) || value.startsWith("//")) {
    return DEFAULT_TARGET;
  }
  try {
    const base = "https://origin.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return DEFAULT_TARGET;
    return url.pathname + url.search + url.hash;
  } catch {
    return DEFAULT_TARGET;
  }
}
