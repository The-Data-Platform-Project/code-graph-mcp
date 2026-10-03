import { DEMO_COLORS } from "@/lib/demo-colors";
import { HERO_FOCUS, heroGraph } from "@/lib/demo-graph";

const STEPS = [
  { t: "Repository", s: "files on disk" },
  { t: "Parse", s: "tree-sitter" },
  { t: "Code graph", s: "Postgres" },
  { t: "MCP", s: "7 read tools" },
  { t: "AI agent", s: "Claude Code" },
];

/**
 * Hero: the pipeline, a real slice of ContextForge's own graph around
 * Indexer.index_full, and the real answer an agent gets when it asks what
 * that method calls. Static SVG and HTML; the only motion is a CSS sweep
 * across the steps, switched off for reduced motion.
 */
export default function HeroVisual() {
  const g = heroGraph(HERO_FOCUS);
  const f = g.focus;
  return (
    <div className="pipeline" aria-label="From repository to AI agent">
      <ol className="pipeline-steps" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {STEPS.map((s, i) => (
          <li key={s.t} className={`pipe-step${i === 2 ? " on" : ""}`}>
            <div className="n">0{i + 1}</div>
            <div className="t">{s.t}</div>
            <div className="s">{s.s}</div>
          </li>
        ))}
      </ol>
      <div className="pipeline-body">
        <svg
          className="mini-graph"
          viewBox={`0 0 ${g.width} ${g.height}`}
          role="img"
          aria-label="A slice of ContextForge's own code graph: the index_full method, what it calls, and what calls it"
        >
          {g.links.map((l, i) => {
            const s = g.nodes[l.s];
            const t = g.nodes[l.t];
            return (
              <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                    className={l.s === f || l.t === f ? "hot" : undefined} />
            );
          })}
          {g.nodes.map((n, i) => (
            <g key={n.id}>
              <circle cx={n.x} cy={n.y} r={i === f ? 8 : n.r + 1.5}
                      fill={DEMO_COLORS[n.kind] ?? "#94a3a2"}
                      stroke={i === f ? "#ccfbf1" : "none"} strokeWidth={i === f ? 2 : 0} />
              <text className="lbl" x={n.x + (i === f ? 12 : n.r + 5)} y={n.y + 3.5}
                    fill={i === f ? "#e9f3f3" : undefined}>
                {n.name}
              </text>
            </g>
          ))}
        </svg>
        <div className="term">
          <div className="term-head">
            <span className="dot" /><span className="dot" /><span className="dot" />
            <span className="title">agent → code-graph</span>
          </div>
          <pre>
            <span className="p">›</span> <span className="k">get_callees</span>(
            <span className="s">&quot;src.code_graph.indexer.Indexer.index_full&quot;</span>){"\n"}
            <span className="c">  resolved</span>   db.connect            <span className="c">db.py:97</span>{"\n"}
            <span className="c">  resolved</span>   Indexer._ingest       <span className="c">indexer.py:147</span>{"\n"}
            <span className="c">  resolved</span>   _clear_repo           <span className="c">indexer.py:297</span>{"\n"}
            <span className="c">  resolved</span>   _finalize             <span className="c">indexer.py:314</span>{"\n"}
            <span className="c">  resolved</span>   resolver.resolve_repo <span className="c">resolver.py:57</span>{"\n"}
            <span className="c">  unresolved con.close          library call</span>
          </pre>
        </div>
      </div>
    </div>
  );
}
