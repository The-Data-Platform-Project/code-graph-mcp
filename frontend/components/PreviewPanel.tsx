"use client";

import { useEffect, useMemo, useState } from "react";
import { codeBlock, esc, langOf, renderMarkdown } from "@/lib/render";
import { KIND_COLORS, NodeContext, isFileKind } from "./types";

type Readme = {
  found: boolean;
  error?: string;
  repo?: string;
  file_path?: string;
  format?: string;
  content?: string;
  truncated?: boolean;
};

export type PreviewTarget =
  | { kind: "readme"; repo: string }
  | { kind: "node"; repo: string; qname: string; label: string; tab?: Tab };

type Tab = "symbol" | "file" | "connections";

const MAX_LINES = 4000;

export default function PreviewPanel({
  target,
  onClose,
  onNavigate,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
  onNavigate: (repo: string, qname: string) => void;
}) {
  const [readme, setReadme] = useState<Readme | null>(null);
  const [context, setContext] = useState<NodeContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("symbol");

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReadme(null);
    setContext(null);

    const url =
      target.kind === "readme"
        ? `/api/readme?repo=${encodeURIComponent(target.repo)}`
        : `/api/node?repo=${encodeURIComponent(target.repo)}&qname=${encodeURIComponent(target.qname)}`;

    fetch(url, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (target.kind === "readme") {
          setReadme(body);
        } else {
          setContext(body);
          setTab(
            target.tab ??
              (body.found && !isFileKind(body.node.kind) ? "symbol" : "file"),
          );
        }
      })
      .catch((err) => !cancelled && setError(String(err)))
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!target) return null;

  return (
    <aside id="preview" className="open">
      <header className="preview-head">
        <div className="preview-title-row">
          <div className="preview-title">
            {target.kind === "readme" ? (
              target.repo
            ) : context?.found ? (
              <>
                <span
                  className="kind-pill"
                  style={{ background: KIND_COLORS[context.node.kind] ?? "#94a3a2" }}
                >
                  {context.node.kind}
                </span>
                <span style={{ marginLeft: 8 }}>{context.node.name}</span>
              </>
            ) : (
              target.label
            )}
          </div>
          <button className="icon-btn" onClick={onClose} title="Close preview (Esc)">
            ✕
          </button>
        </div>
        <div className="preview-sub">
          {target.kind === "readme"
            ? (readme?.file_path ?? "README")
            : context?.found
              ? `${context.node.repo} · ${context.node.file_path}` +
                (isFileKind(context.node.kind)
                  ? ""
                  : `:${context.node.start_line}-${context.node.end_line}`)
              : ""}
        </div>
        {target.kind === "node" && context?.found && (
          <Tabs context={context} tab={tab} setTab={setTab} />
        )}
        {target.kind === "readme" && readme?.found && (
          <div className="preview-tabs">
            <button className="preview-tab active">README</button>
          </div>
        )}
      </header>

      <div className="preview-body">
        {loading && (
          <div className="preview-empty">
            <div className="loading-spinner" style={{ margin: "0 auto" }} />
          </div>
        )}
        {!loading && error && <Message text={error} />}
        {!loading && target.kind === "readme" && readme && (
          <ReadmeView readme={readme} />
        )}
        {!loading && target.kind === "node" && context && (
          <NodeView context={context} tab={tab} onNavigate={onNavigate} />
        )}
      </div>
    </aside>
  );
}

function Message({ text }: { text: string }) {
  return (
    <div className="preview-empty">
      <p>{text}</p>
    </div>
  );
}

function Tabs({
  context,
  tab,
  setTab,
}: {
  context: NodeContext;
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const count =
    context.callers.length +
    context.callees.length +
    context.dependencies.length +
    context.dependents.length +
    context.siblings.length;
  const tabs: Array<[Tab, string, number | null]> = [];
  if (!isFileKind(context.node.kind)) tabs.push(["symbol", "Symbol", null]);
  tabs.push(["file", "File", null]);
  tabs.push(["connections", "Connections", count]);

  return (
    <div className="preview-tabs">
      {tabs.map(([id, label, n]) => (
        <button
          key={id}
          className={`preview-tab ${id === tab ? "active" : ""}`}
          onClick={() => setTab(id)}
        >
          {label}
          {n != null && <span className="count">{n}</span>}
        </button>
      ))}
    </div>
  );
}

function ReadmeView({ readme }: { readme: Readme }) {
  if (!readme.found) {
    return <Message text={readme.error ?? "No README found."} />;
  }
  const isMarkdown = readme.format === ".md" || readme.format === ".markdown";
  const html = isMarkdown
    ? renderMarkdown(readme.content ?? "")
    : codeBlock(readme.content ?? "", "", 1, 0, -1);
  return (
    <>
      {readme.truncated && (
        <div className="preview-note">
          Showing the first {Math.round((readme.content ?? "").length / 1024)} KB
          of a larger file.
        </div>
      )}
      <div
        className={isMarkdown ? "md-view" : "code-view"}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}

function NodeView({
  context,
  tab,
  onNavigate,
}: {
  context: NodeContext;
  tab: Tab;
  onNavigate: (repo: string, qname: string) => void;
}) {
  if (!context.found) {
    return <Message text={context.error ?? "Not found."} />;
  }
  if (tab === "connections") {
    return <Connections context={context} onNavigate={onNavigate} />;
  }
  return <Source context={context} symbolOnly={tab === "symbol"} />;
}

function Source({
  context,
  symbolOnly,
}: {
  context: NodeContext;
  symbolOnly: boolean;
}) {
  const { node, source } = context;

  const rendered = useMemo(() => {
    if (!source.found || source.content == null) return null;
    const lang = langOf(node.file_path);
    const lines = source.content.split("\n");

    if (symbolOnly) {
      const from = Math.max(1, node.start_line);
      const to = Math.min(lines.length, node.end_line);
      return {
        html: codeBlock(lines.slice(from - 1, to).join("\n"), lang, from, from, to),
        note: null as string | null,
      };
    }
    let note: string | null = source.truncated
      ? `File truncated at ${Math.round((source.bytes ?? 0) / 1024)} KB.`
      : null;
    let text = source.content;
    if (lines.length > MAX_LINES) {
      text = lines.slice(0, MAX_LINES).join("\n");
      note = `Showing the first ${MAX_LINES} of ${lines.length} lines.`;
    }
    const hlFrom = isFileKind(node.kind) ? 0 : node.start_line;
    const hlTo = isFileKind(node.kind) ? -1 : node.end_line;
    return { html: codeBlock(text, lang, 1, hlFrom, hlTo), note };
  }, [node, source, symbolOnly]);

  if (!rendered) {
    // The graph lives in Postgres but source text comes from the machine that
    // holds the repo, so this pane — and only this pane — needs the tunnel.
    return <Message text={source.error ?? "Source unavailable."} />;
  }
  return (
    <>
      {rendered.note && <div className="preview-note">{rendered.note}</div>}
      <div
        className="code-view"
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
    </>
  );
}

function short(qname: string) {
  return qname.split(/[./]/).pop() || qname;
}
function fileName(path: string) {
  return path.split("/").pop() || path;
}

function Connections({
  context,
  onNavigate,
}: {
  context: NodeContext;
  onNavigate: (repo: string, qname: string) => void;
}) {
  const repo = context.node.repo;
  type Row = {
    name: string;
    qname: string | null;
    kind: string | null;
    path: string;
    unresolved?: boolean;
  };

  const groups: Array<[string, Row[], string]> = [
    [
      "Called by",
      context.callers.map((c) => ({
        name: short(c.qualified_name),
        qname: c.qualified_name,
        kind: c.kind,
        path: `${c.file_path}:${c.start_line}`,
      })),
      "Nothing in the graph calls this.",
    ],
    [
      "Calls",
      context.callees.map((c) => ({
        name: c.resolved ? short(c.callee) : c.callee,
        qname: c.resolved ? c.callee : null,
        kind: c.kind,
        path: c.resolved && c.file_path ? `${c.file_path}:${c.start_line}` : "unresolved",
        unresolved: !c.resolved,
      })),
      "This symbol calls nothing the graph could resolve.",
    ],
    [
      `Imports of ${fileName(context.node.file_path)}`,
      context.dependencies.map((d) => ({
        name: d.local_name || d.target,
        qname: d.in_project ? d.target : null,
        kind: null,
        path: d.in_project ? d.target : "external",
        unresolved: !d.in_project,
      })),
      "This file imports nothing.",
    ],
    [
      "Imported by",
      context.dependents.map((d) => ({
        name: fileName(d.file_path),
        qname: null,
        kind: null,
        path: d.file_path,
      })),
      "No indexed file imports this one.",
    ],
    [
      "Also in this file",
      context.siblings.map((s) => ({
        name: s.name,
        qname: s.qualified_name,
        kind: s.kind,
        path: `line ${s.start_line}`,
      })),
      "Nothing else is defined in this file.",
    ],
  ];

  return (
    <div className="conn-view">
      {groups.map(([title, rows, empty]) => (
        <section className="conn-group" key={title}>
          <h4>
            {title} {rows.length > 0 && `(${rows.length})`}
          </h4>
          {rows.length === 0 ? (
            <div className="conn-empty">{empty}</div>
          ) : (
            rows.map((r, i) => (
              <div
                key={`${r.name}-${i}`}
                className={`conn-row ${r.qname ? "clickable" : ""}`}
                onClick={() => r.qname && onNavigate(repo, r.qname)}
              >
                {r.kind && (
                  <span
                    className="cr-kind"
                    style={{ background: KIND_COLORS[r.kind] ?? "#94a3a2" }}
                  >
                    {r.kind}
                  </span>
                )}
                <span className="cr-name">{r.name}</span>
                {r.path && (
                  <span className={`cr-path ${r.unresolved ? "cr-unresolved" : ""}`}>
                    {r.path}
                  </span>
                )}
              </div>
            ))
          )}
        </section>
      ))}
    </div>
  );
}

// `esc` is re-exported for tests of the rendering pipeline.
export { esc };
