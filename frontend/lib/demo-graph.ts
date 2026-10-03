import "server-only";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3";
import demo from "@/content/demo-graph.json";

/**
 * The public demo graph: the Python core of ContextForge's own repository
 * (src/code_graph/, extractors excluded), exported from a real index. It is
 * the only graph data the public site shows — no other repository appears.
 *
 * Layout runs here, at build time, so the browser receives finished
 * coordinates and a little interaction code, not a physics simulation.
 */

type RawNode = { id: string; name: string; kind: string; file_path: string; start_line: number };
type RawLink = { source: string; target: string; type: string };

export type DemoNode = {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  x: number;
  y: number;
  r: number;
};
export type DemoLink = { s: number; t: number; type: string };
export type DemoGraph = { nodes: DemoNode[]; links: DemoLink[]; width: number; height: number };

export const DEMO_REPO: string = (demo as { repo: string }).repo;

const RADIUS: Record<string, number> = { File: 6, Class: 7, Function: 4, Method: 3.6, Interface: 6 };

type SimNode = RawNode & { x?: number; y?: number; index?: number };

function layout(
  rawNodes: RawNode[],
  rawLinks: RawLink[],
  width: number,
  height: number,
  opts: { charge: number; distance: number; ticks: number },
): DemoGraph {
  // Nodes with no edge in this slice would float off and shrink the fit.
  const ids = new Set(rawNodes.map((n) => n.id));
  const kept = rawLinks.filter((l) => ids.has(l.source) && ids.has(l.target));
  const linked = new Set(kept.flatMap((l) => [l.source, l.target]));
  const nodes: SimNode[] = rawNodes.filter((n) => linked.has(n.id)).map((n) => ({ ...n }));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const links = kept.map((l) => ({
    source: index.get(l.source)!,
    target: index.get(l.target)!,
    type: l.type,
  }));

  // Deterministic: d3-force seeds positions on a phyllotaxis, not at random.
  const sim = forceSimulation(nodes)
    .force(
      "link",
      forceLink(links.map((l) => ({ ...l })))
        .distance((l) => ((l as { type: string }).type === "CONTAINS" ? opts.distance * 0.6 : opts.distance))
        .strength(0.5),
    )
    .force("charge", forceManyBody().strength(opts.charge))
    .force("x", forceX(0).strength(0.06))
    .force("y", forceY(0).strength(0.09))
    .force("collide", forceCollide((n) => (RADIUS[(n as SimNode).kind] ?? 4) + 3))
    .stop();
  for (let i = 0; i < opts.ticks; i++) sim.tick();

  // Fit into the box with a margin.
  const xs = nodes.map((n) => n.x!);
  const ys = nodes.map((n) => n.y!);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Labels sit to the right of each node, so leave more room on that side.
  const pad = 36;
  const padRight = 110;
  const k = Math.min(
    (width - pad - padRight) / (maxX - minX || 1),
    (height - 2 * pad) / (maxY - minY || 1),
  );
  const ox = pad + (width - pad - padRight - k * (maxX - minX)) / 2;
  const oy = (height - k * (maxY - minY)) / 2;

  return {
    width,
    height,
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      file: n.file_path,
      line: n.start_line,
      x: Math.round((ox + (n.x! - minX) * k) * 10) / 10,
      y: Math.round((oy + (n.y! - minY) * k) * 10) / 10,
      r: RADIUS[n.kind] ?? 4,
    })),
    links: links.map((l) => ({ s: l.source, t: l.target, type: l.type })),
  };
}

const RAW_NODES = (demo as { nodes: RawNode[] }).nodes;
const RAW_LINKS = (demo as { links: RawLink[] }).links;

/** The whole demo subgraph, for the interactive showcase. */
export function demoGraph(): DemoGraph {
  return layout(RAW_NODES, RAW_LINKS, 960, 600, { charge: -46, distance: 34, ticks: 400 });
}

/** A focused slice for the hero: one symbol, what it calls and what calls it. */
export function heroGraph(focusId: string): DemoGraph & { focus: number } {
  const calls = RAW_LINKS.filter((l) => l.type === "CALLS");
  const keep = new Set<string>([focusId]);
  for (const l of calls) {
    if (l.source === focusId) keep.add(l.target);
    if (l.target === focusId) keep.add(l.source);
  }
  // One more hop downstream, for texture.
  for (const l of calls) if (keep.has(l.source) && keep.size < 22) keep.add(l.target);
  const nodes = RAW_NODES.filter((n) => keep.has(n.id));
  const links = calls.filter((l) => keep.has(l.source) && keep.has(l.target));
  const g = layout(nodes, links, 520, 250, { charge: -140, distance: 58, ticks: 300 });
  return { ...g, focus: g.nodes.findIndex((n) => n.id === focusId) };
}

export const HERO_FOCUS = "src.code_graph.indexer.Indexer.index_full";
