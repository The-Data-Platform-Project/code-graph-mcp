/**
 * Source text for previews: README bodies and file contents.
 *
 * The graph never stores source, so it comes from a provider, chosen by
 * SOURCE_PROVIDER:
 *
 *   github  the repo recorded for this tenant in control.repo_connections,
 *           read through the GitHub contents API (GITHUB_TOKEN for private
 *           repos). The cloud default.
 *   mcp     the code-graph container's /api/file and /api/readme — for local
 *           or tunnelled setups where the repos are on disk.
 *   none    previews switched off; the graph itself still works.
 *
 * Every provider returns the shape the Python service returns
 * (queries.get_file_source / get_repo_readme), so the UI does not care which
 * one answered.
 */
import { repoConnection } from "./control";
import { githubToken, sourceProvider } from "./env";
import { mcpGet } from "./mcp";
import type { Tenant } from "./tenancy";

export type SourceResult =
  | {
      found: true;
      content: string;
      bytes: number;
      truncated: boolean;
      line_count: number;
      repo: string;
      file_path: string;
      format?: string;
    }
  | { found: false; error: string };

const MAX_SOURCE_BYTES = 1_000_000;

function notFound(error: string): SourceResult {
  return { found: false, error };
}

/** Same rules as the Python _read_text_capped: cap, refuse binary, whole lines. */
function textResult(repo: string, filePath: string, bytes: Uint8Array): SourceResult {
  const head = bytes.subarray(0, Math.min(bytes.length, MAX_SOURCE_BYTES));
  if (head.subarray(0, 8192).includes(0)) return notFound("binary file; nothing to preview");
  const truncated = bytes.length > head.length;
  let text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  if (truncated) {
    const cut = text.lastIndexOf("\n");
    if (cut > 0) text = text.slice(0, cut);
  }
  return {
    found: true,
    content: text,
    bytes: bytes.length,
    truncated,
    line_count: text ? text.split("\n").length : 0,
    repo,
    file_path: filePath,
  };
}

/** Refuse anything that is not a plain relative path inside the repository. */
function safeRelPath(path: string): string | null {
  const p = path.trim();
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  const parts = p.split("/");
  if (parts.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return parts.map(encodeURIComponent).join("/");
}

// ── GitHub ──────────────────────────────────────────────────────────────────

async function githubFetch(url: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "code-graph",
  };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(15_000) });
}

function githubError(status: number, what: string): SourceResult {
  if (status === 404) {
    return notFound(
      `${what} not found on GitHub — the repo is private and GITHUB_TOKEN cannot see it, ` +
        "or the path or ref no longer exists",
    );
  }
  if (status === 403 || status === 429) {
    return notFound("GitHub rate limit or permission refusal — set GITHUB_TOKEN");
  }
  return notFound(`GitHub returned ${status} for ${what}`);
}

// Same rule as the CHECK on control.repo_connections, enforced again here
// because the value becomes part of a URL.
const EXTERNAL_REPO_RE = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/;

async function connectionFor(tenant: Tenant, repo: string) {
  const conn = await repoConnection(tenant.id, repo);
  if (!conn) return { error: notFound(`no source connection for repo "${repo}"`) };
  if (!EXTERNAL_REPO_RE.test(conn.externalRepo)) {
    return { error: notFound(`invalid GitHub repo "${conn.externalRepo}"`) };
  }
  return { conn };
}

async function githubFile(tenant: Tenant, repo: string, path: string): Promise<SourceResult> {
  const { conn, error } = await connectionFor(tenant, repo);
  if (!conn) return error;
  const rel = safeRelPath(path);
  if (!rel) return notFound("invalid path");
  const ref = conn.gitRef ? `?ref=${encodeURIComponent(conn.gitRef)}` : "";
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${conn.externalRepo}/contents/${rel}${ref}`,
      "application/vnd.github.raw",
    );
    if (!res.ok) return githubError(res.status, path);
    return textResult(repo, path, new Uint8Array(await res.arrayBuffer()));
  } catch (err) {
    return notFound(`could not reach GitHub: ${err instanceof Error ? err.message : err}`);
  }
}

async function githubReadme(tenant: Tenant, repo: string): Promise<SourceResult> {
  const { conn, error } = await connectionFor(tenant, repo);
  if (!conn) return error;
  const ref = conn.gitRef ? `?ref=${encodeURIComponent(conn.gitRef)}` : "";
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${conn.externalRepo}/readme${ref}`,
      "application/vnd.github+json",
    );
    if (!res.ok) return githubError(res.status, "README");
    const body = (await res.json()) as { name: string; content: string; encoding: string };
    const bytes = Uint8Array.from(atob(body.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
    const result = textResult(repo, body.name, bytes);
    if (result.found) {
      const dot = body.name.lastIndexOf(".");
      result.format = dot >= 0 ? body.name.slice(dot).toLowerCase() : "";
    }
    return result;
  } catch (err) {
    return notFound(`could not reach GitHub: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function readFile(tenant: Tenant, repo: string, path: string): Promise<SourceResult> {
  switch (sourceProvider()) {
    case "github":
      return githubFile(tenant, repo, path);
    case "mcp":
      return (await mcpGet("/api/file", { repo, path })).body as SourceResult;
    case "none":
      return notFound("source previews are switched off in this deployment");
  }
}

export async function readReadme(tenant: Tenant, repo: string): Promise<SourceResult> {
  switch (sourceProvider()) {
    case "github":
      return githubReadme(tenant, repo);
    case "mcp":
      return (await mcpGet("/api/readme", { repo })).body as SourceResult;
    case "none":
      return notFound("source previews are switched off in this deployment");
  }
}
