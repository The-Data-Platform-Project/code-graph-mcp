/**
 * Talking to the cloud indexer (infra/aws, src/code_graph/etl).
 *
 * One shared secret, INDEXER_SECRET, does two jobs, each under its own label
 * so neither value can stand in for the other (etl/signing.py is the twin):
 *  - each repo connection's GitHub webhook secret is derived from it, so the
 *    app can show or register it without storing it;
 *  - "Index now" requests are signed with it, with a timestamp the indexer
 *    checks, so a captured request cannot be replayed later.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { indexerSecret, indexerUrl } from "./env";

export function indexerConfigured(): boolean {
  return !!(indexerUrl() && indexerSecret());
}

export function webhookUrl(): string {
  return `${indexerUrl()}/github`;
}

export function webhookSecret(tenantId: number, repoName: string): string {
  return createHmac("sha256", indexerSecret())
    .update(`webhook:${Math.trunc(tenantId)}:${repoName}`)
    .digest("hex");
}

/** Ask the indexer to queue a run for one of this tenant's connections. */
export async function requestIndex(
  tenantId: number,
  repoName: string,
): Promise<{ ok: boolean; queued: boolean; message: string }> {
  if (!indexerConfigured()) {
    return { ok: false, queued: false, message: "no indexer is deployed (INDEXER_URL is not set)" };
  }
  const body = JSON.stringify({ tenant_id: tenantId, repo_name: repoName });
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", indexerSecret()).update(`enqueue:${ts}.${body}`).digest("hex");
  try {
    const res = await fetch(`${indexerUrl()}/enqueue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CG-Timestamp": String(ts),
        "X-CG-Signature": `v1=${sig}`,
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { queued?: boolean; reason?: string; error?: string };
    if (!res.ok) return { ok: false, queued: false, message: data.error ?? `indexer returned ${res.status}` };
    return {
      ok: true,
      queued: !!data.queued,
      message: data.queued ? "queued" : (data.reason ?? "already queued"),
    };
  } catch (err) {
    return { ok: false, queued: false, message: `could not reach the indexer: ${err instanceof Error ? err.message : err}` };
  }
}
