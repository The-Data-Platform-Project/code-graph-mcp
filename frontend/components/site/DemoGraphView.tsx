"use client";

import { useMemo, useState } from "react";
import { DEMO_COLORS } from "@/lib/demo-colors";
import type { DemoGraph } from "@/lib/demo-graph";

const short = (id: string) => id.split(".").pop() ?? id;
const base = (p: string) => p.split("/").pop() ?? p;

/**
 * A static, pre-laid-out graph with the explorer's core gestures: hover to
 * see a node's neighbourhood, click to inspect it, follow its connections.
 * Everything in the side panel is a button, so the graph is navigable by
 * keyboard without aiming at dots.
 */
export default function DemoGraphView({
  graph,
  initial,
  repo,
}: {
  graph: DemoGraph;
  initial: number;
  repo: string;
}) {
  const [selected, setSelected] = useState(initial);
  const [hovered, setHovered] = useState<number | null>(null);

  const adj = useMemo(() => {
    const out = graph.nodes.map(() => ({
      callers: [] as number[],
      calls: [] as number[],
      imports: [] as number[],
      importedBy: [] as number[],
      contains: [] as number[],
      parent: -1,
    }));
    for (const l of graph.links) {
      if (l.type === "CALLS") {
        out[l.s].calls.push(l.t);
        out[l.t].callers.push(l.s);
      } else if (l.type === "IMPORTS") {
        out[l.s].imports.push(l.t);
        out[l.t].importedBy.push(l.s);
      } else if (l.type === "CONTAINS") {
        out[l.s].contains.push(l.t);
        out[l.t].parent = l.s;
      }
    }
    return out;
  }, [graph]);

  const focus = hovered ?? selected;
  const lit = useMemo(() => {
    const set = new Set<number>([focus]);
    for (const l of graph.links) {
      if (l.s === focus) set.add(l.t);
      if (l.t === focus) set.add(l.s);
    }
    return set;
  }, [focus, graph.links]);

  const node = graph.nodes[selected];
  const a = adj[selected];
  const groups: [string, number[]][] = [
    ["Called by", a.callers],
    ["Calls", a.calls],
    ["Imports", a.imports],
    ["Imported by", a.importedBy],
    ["Contains", a.contains],
    ["Defined in", a.parent >= 0 ? [a.parent] : []],
  ];

  return (
    <div className="demo">
      <div className="demo-canvas focus">
        <svg
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          role="img"
          aria-label={`Graph of ${graph.nodes.length} files, classes, functions and methods from the ${repo} repository, with ${graph.links.length} relationships`}
        >
          {graph.links.map((l, i) => {
            const s = graph.nodes[l.s];
            const t = graph.nodes[l.t];
            const on = l.s === focus || l.t === focus;
            return (
              <line
                key={i}
                x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                className={`${l.type}${on ? " on" : ""}`}
              />
            );
          })}
          {graph.nodes.map((n, i) => (
            <circle
              key={n.id}
              cx={n.x}
              cy={n.y}
              r={i === selected ? n.r + 1.5 : n.r}
              fill={DEMO_COLORS[n.kind] ?? "#94a3a2"}
              className={`${lit.has(i) ? "on" : ""}${i === selected ? " sel" : ""}`}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => setSelected(i)}
            >
              <title>{`${n.kind} ${n.id}`}</title>
            </circle>
          ))}
          {graph.nodes.map((n, i) =>
            n.kind === "File" || lit.has(i) ? (
              <text key={`t${n.id}`} x={n.x + n.r + 3} y={n.y + 3} className={lit.has(i) ? "on" : ""}>
                {n.kind === "File" ? base(n.file) : n.name}
              </text>
            ) : null,
          )}
        </svg>
        <div className="demo-legend" aria-hidden="true">
          {Object.entries(DEMO_COLORS)
            .filter(([k]) => graph.nodes.some((n) => n.kind === k))
            .map(([k, c]) => (
              <span key={k}><i style={{ background: c }} />{k}</span>
            ))}
          <span>— calls</span>
          <span>- - imports</span>
        </div>
      </div>

      <aside className="demo-panel" aria-live="polite">
        <div>
          <span className="kind" style={{ color: DEMO_COLORS[node.kind] }}>{node.kind}</span>
          <h4>{node.kind === "File" ? node.file : node.name}</h4>
          <div className="loc">{node.file}:{node.line}</div>
        </div>
        {groups.map(([label, ids]) =>
          ids.length ? (
            <div className="grp" key={label}>
              <span>{label} · {ids.length}</span>
              {ids.slice(0, 8).map((id) => (
                <button key={id} type="button" onClick={() => setSelected(id)}>
                  {graph.nodes[id].kind === "File" ? base(graph.nodes[id].file) : short(graph.nodes[id].id)}
                </button>
              ))}
              {ids.length > 8 && <span className="empty">and {ids.length - 8} more</span>}
            </div>
          ) : null,
        )}
        {groups.every(([, ids]) => !ids.length) && (
          <p className="empty">No connections inside this slice of the graph.</p>
        )}
      </aside>
    </div>
  );
}
