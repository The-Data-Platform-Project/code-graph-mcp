/**
 * Talking to the code-graph container.
 *
 * Only source *text* comes from here — README bodies and file contents — since
 * the repositories exist on the user's machine and nowhere else. Locally this
 * is the compose service; from Vercel it is the ngrok URL.
 *
 * The token never reaches the browser: these helpers run server-side only, and
 * the app's own routes are what the page calls.
 */
import { mcpBaseUrl, mcpToken } from "./env";

export type McpResult = { status: number; body: unknown };

export async function mcpGet(
  path: string,
  params: Record<string, string>,
): Promise<McpResult> {
  const url = new URL(mcpBaseUrl() + path);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = mcpToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      headers,
      // Source is read fresh from disk on every request; caching it would show
      // stale code after an edit.
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({
      found: false,
      error: `code-graph service returned ${res.status}`,
    }));
    return { status: res.status, body };
  } catch (err) {
    // The tunnel being down is the normal failure here, and the page should
    // say so plainly rather than look broken.
    return {
      status: 503,
      body: {
        found: false,
        error:
          "the code-graph service is unreachable — is the container running " +
          "and the tunnel up? " +
          (err instanceof Error ? err.message : String(err)),
      },
    };
  }
}
