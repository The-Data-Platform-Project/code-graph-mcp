"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import GraphCanvas from "./GraphCanvas";
import PreviewPanel, { PreviewTarget } from "./PreviewPanel";
import {
  ALL_EDGES,
  ALL_KINDS,
  EDGE_COLORS,
  GraphNode,
  GraphPayload,
  KIND_COLORS,
} from "./types";

export default function Explorer() {
  const [data, setData] = useState<GraphPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [repo, setRepo] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kinds, setKinds] = useState(new Set(ALL_KINDS));
  const [edges, setEdges] = useState(
    new Set(ALL_EDGES.filter((e) => e !== "CONTAINS")),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);

  useEffect(() => {
    fetch("/api/graph", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setData(body);
        if (body.repos?.length) {
          // Default to the smallest repo so the first paint is legible.
          const smallest = body.repos.reduce(
            (a: { edge_count: number }, b: { edge_count: number }) =>
              a.edge_count < b.edge_count ? a : b,
          );
          setRepo(smallest.name);
        }
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.toLowerCase()), 200);
    return () => clearTimeout(id);
  }, [search]);

  const filtered = useMemo(() => {
    if (!data) return { nodes: [], links: [] };
    let nodes = data.nodes;
    if (repo) nodes = nodes.filter((n) => n.repo === repo);
    nodes = nodes.filter((n) => kinds.has(n.kind));
    if (debounced) {
      nodes = nodes.filter(
        (n) =>
          n.name.toLowerCase().includes(debounced) ||
          n.id.toLowerCase().includes(debounced),
      );
    }
    const ids = new Set(nodes.map((n) => n.id));
    const links = data.links.filter(
      (l) =>
        edges.has(l.type) &&
        ids.has(l.source as string) &&
        ids.has(l.target as string),
    );
    return { nodes, links };
  }, [data, repo, kinds, edges, debounced]);

  const onSelect = useCallback((node: GraphNode) => {
    setSelectedId(node.id);
    setPreview({
      kind: "node",
      repo: node.repo,
      qname: node.id,
      label: node.name,
    });
  }, []);

  const onNavigate = useCallback((targetRepo: string, qname: string) => {
    setSelectedId(qname);
    setPreview({
      kind: "node",
      repo: targetRepo,
      qname,
      label: qname.split(/[./]/).pop() ?? qname,
    });
  }, []);

  const stats = useMemo(() => {
    if (!data) return null;
    return {
      nodes: filtered.nodes.length,
      edges: filtered.links.filter((l) => l.type !== "CONTAINS").length,
      files: new Set(filtered.nodes.map((n) => n.file_path)).size,
    };
  }, [data, filtered]);

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <div id="app">
      <div id="sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 3v4m0 10v4M3 12h4m10 0h4" />
                <path d="M5.6 5.6l2.85 2.85m7.1 7.1l2.85 2.85M5.6 18.4l2.85-2.85m7.1-7.1l2.85-2.85" />
              </svg>
            </div>
            <div className="logo-text">
              Code<span>Graph</span>
            </div>
          </div>
          <div className="stats-row" id="stats">
            {(["nodes", "edges", "files"] as const).map((key) => (
              <div className="stat-cell" key={key}>
                <div className="stat-val">
                  {stats ? stats[key].toLocaleString() : "—"}
                </div>
                <div className="stat-label">{key}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="sidebar-controls">
          <div className="control-group">
            <label className="section-label">Repository</label>
            <select
              id="repo-select"
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);
                // Selecting a repo shows what it is: its README, straight away.
                if (e.target.value) {
                  setPreview({ kind: "readme", repo: e.target.value });
                } else {
                  setPreview(null);
                }
              }}
            >
              <option value="">All repositories</option>
              {data?.repos.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name} ({r.node_count} nodes)
                </option>
              ))}
            </select>
            <button
              className="readme-btn"
              id="readme-btn"
              disabled={!repo}
              onClick={() => repo && setPreview({ kind: "readme", repo })}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span>Preview README</span>
            </button>
          </div>

          <div className="control-group">
            <label className="section-label">Search</label>
            <div className="search-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                id="search"
                placeholder="Find a symbol..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="control-group">
            <label className="section-label">Node types</label>
            <div className="pill-group" id="kind-filters">
              {ALL_KINDS.map((k) => (
                <label
                  key={k}
                  className={`pill ${kinds.has(k) ? "active" : ""}`}
                  data-kind={k}
                  onClick={() => setKinds((s) => toggle(s, k))}
                >
                  <span className="swatch" style={{ background: KIND_COLORS[k] }} />
                  {k}
                </label>
              ))}
            </div>
          </div>

          <div className="control-group">
            <label className="section-label">Edges</label>
            <div className="pill-group" id="edge-filters">
              {ALL_EDGES.map((e) => (
                <label
                  key={e}
                  className={`pill ${edges.has(e) ? "active" : ""}`}
                  data-edge={e}
                  onClick={() => setEdges((s) => toggle(s, e))}
                >
                  <span className="line-sw" style={{ background: EDGE_COLORS[e] }} />
                  {e}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {loadError ? (
        <div id="graph-area">
          <div className="empty-state">
            <h2>Could not load the graph</h2>
            <p>{loadError}</p>
            <p style={{ marginTop: 10 }}>
              Check <code>DATABASE_URL</code> and that a repository has been
              indexed.
            </p>
          </div>
        </div>
      ) : !data ? (
        <div id="graph-area">
          <div className="loading-overlay">
            <div className="loading-spinner" />
          </div>
        </div>
      ) : filtered.nodes.length === 0 ? (
        <div id="graph-area">
          <div className="empty-state">
            <h2>No nodes to display</h2>
            <p>Try adjusting your filters or selecting a different repository.</p>
          </div>
        </div>
      ) : (
        <GraphCanvas
          nodes={filtered.nodes}
          links={filtered.links}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}

      <PreviewPanel
        target={preview}
        onClose={() => setPreview(null)}
        onNavigate={onNavigate}
      />
    </div>
  );
}
