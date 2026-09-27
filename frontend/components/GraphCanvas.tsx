"use client";

import { useEffect, useRef } from "react";
import * as d3 from "d3";
import {
  EDGE_COLORS,
  GraphLink,
  GraphNode,
  KIND_COLORS,
  KIND_RADIUS,
} from "./types";

/**
 * The force-directed graph, drawn on a canvas.
 *
 * Canvas rather than SVG because a few thousand nodes as DOM elements makes
 * panning stutter; the simulation and hit-testing are the same either way.
 */
export default function GraphCanvas({
  nodes,
  links,
  selectedId,
  onSelect,
}: {
  nodes: GraphNode[];
  links: GraphLink[];
  selectedId: string | null;
  onSelect: (node: GraphNode) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    transform: d3.zoomIdentity,
    hovered: null as GraphNode | null,
    selectedId,
  });

  stateRef.current.selectedId = selectedId;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // d3 mutates the objects it simulates, so hand it copies and leave the
    // props untouched.
    const simNodes: GraphNode[] = nodes.map((n) => ({ ...n }));
    const simLinks = links.map((l) => ({ ...l }));

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };
    resize();

    const draw = () => {
      const { transform, hovered } = stateRef.current;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);

      for (const l of simLinks) {
        const s = l.source as GraphNode;
        const t = l.target as GraphNode;
        if (s?.x == null || t?.x == null) continue;
        const isContains = l.type === "CONTAINS";
        ctx.beginPath();
        ctx.moveTo(s.x, s.y!);
        ctx.lineTo(t.x, t.y!);
        ctx.strokeStyle = EDGE_COLORS[l.type] || "#cbd5d4";
        ctx.globalAlpha = isContains ? 0.08 : 0.3;
        ctx.lineWidth = isContains ? 0.5 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;

        if (!isContains && transform.k > 0.3) {
          const angle = Math.atan2(t.y! - s.y!, t.x - s.x);
          const r = (KIND_RADIUS[t.kind] || 5) + 3;
          const ax = t.x - Math.cos(angle) * r;
          const ay = t.y! - Math.sin(angle) * r;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(ax - 6 * Math.cos(angle - 0.4), ay - 6 * Math.sin(angle - 0.4));
          ctx.lineTo(ax - 6 * Math.cos(angle + 0.4), ay - 6 * Math.sin(angle + 0.4));
          ctx.closePath();
          ctx.fillStyle = EDGE_COLORS[l.type];
          ctx.globalAlpha = 0.5;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      for (const n of simNodes) {
        if (n.x == null) continue;
        const r = KIND_RADIUS[n.kind] || 5;
        const isSelected = n.id === stateRef.current.selectedId;
        const isHovered = hovered?.id === n.id;

        ctx.beginPath();
        ctx.arc(n.x, n.y!, r, 0, Math.PI * 2);
        ctx.fillStyle = KIND_COLORS[n.kind] || "#94a3a2";
        ctx.globalAlpha = isHovered || isSelected ? 1 : 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;

        if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(n.x, n.y!, r + 3, 0, Math.PI * 2);
          ctx.strokeStyle = KIND_COLORS[n.kind] || "#0d9488";
          ctx.globalAlpha = 0.3;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        if (transform.k > 0.8) {
          ctx.font = `${Math.max(9, 11 / transform.k)}px var(--font-sans), sans-serif`;
          ctx.fillStyle = "#475752";
          ctx.globalAlpha = Math.min(1, (transform.k - 0.8) * 3);
          ctx.fillText(n.name, n.x + r + 4, n.y! + 3.5);
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();
    };

    const rect = wrap.getBoundingClientRect();
    const simulation = d3
      .forceSimulation(simNodes)
      .force(
        "link",
        d3
          .forceLink(simLinks)
          .id((d) => (d as GraphNode).id)
          .distance(60)
          .strength(0.3),
      )
      .force("charge", d3.forceManyBody().strength(-80).distanceMax(300))
      .force("center", d3.forceCenter(rect.width / 2, rect.height / 2))
      .force(
        "collision",
        d3.forceCollide().radius((d) => (KIND_RADIUS[(d as GraphNode).kind] || 5) + 2),
      )
      .alphaDecay(0.03)
      .on("tick", draw);

    const nodeAt = (mx: number, my: number): GraphNode | null => {
      const { transform } = stateRef.current;
      const x = (mx - transform.x) / transform.k;
      const y = (my - transform.y) / transform.k;
      for (let i = simNodes.length - 1; i >= 0; i--) {
        const n = simNodes[i];
        if (n.x == null) continue;
        const r = (KIND_RADIUS[n.kind] || 5) + 2;
        if ((n.x - x) ** 2 + (n.y! - y) ** 2 < r * r) return n;
      }
      return null;
    };

    const selection = d3.select(canvas);
    selection.call(
      d3
        .zoom<HTMLCanvasElement, unknown>()
        .scaleExtent([0.05, 12])
        .on("zoom", (event) => {
          stateRef.current.transform = event.transform;
          draw();
        }),
    );
    selection.call(
      d3
        .drag<HTMLCanvasElement, unknown>()
        .subject((event) => {
          const box = canvas.getBoundingClientRect();
          return nodeAt(event.x - box.left, event.y - box.top) as never;
        })
        .on("start", (event) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        })
        .on("drag", (event) => {
          const { transform } = stateRef.current;
          event.subject.fx = (event.x - transform.x) / transform.k;
          event.subject.fy = (event.y - transform.y) / transform.k;
        })
        .on("end", (event) => {
          if (!event.active) simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        }),
    );

    const onMove = (event: MouseEvent) => {
      const box = canvas.getBoundingClientRect();
      const node = nodeAt(event.clientX - box.left, event.clientY - box.top);
      if (node !== stateRef.current.hovered) {
        stateRef.current.hovered = node;
        canvas.style.cursor = node ? "pointer" : "grab";
        draw();
      }
    };
    const onClick = (event: MouseEvent) => {
      const box = canvas.getBoundingClientRect();
      const node = nodeAt(event.clientX - box.left, event.clientY - box.top);
      if (node) onSelect(node);
    };
    const onResize = () => {
      resize();
      draw();
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    window.addEventListener("resize", onResize);

    return () => {
      simulation.stop();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
      window.removeEventListener("resize", onResize);
    };
  }, [nodes, links, onSelect]);

  // Redraw on selection change without restarting the simulation.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.dispatchEvent(new Event("cg:redraw"));
  }, [selectedId]);

  return (
    <div id="graph-area" ref={wrapRef}>
      <canvas id="graph-canvas" ref={canvasRef} />
    </div>
  );
}
