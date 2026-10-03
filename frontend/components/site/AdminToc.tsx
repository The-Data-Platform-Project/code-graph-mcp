"use client";

import { useMemo, useState } from "react";
import type { TocItem } from "@/lib/markdown";

/**
 * The admin guide's outline with a filter box: type to narrow the sections.
 * A matching subsection keeps its parent section visible for context.
 */
export default function AdminToc({ toc }: { toc: TocItem[] }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return toc;
    const keep = new Set<number>();
    let parent = -1;
    toc.forEach((t, i) => {
      if (t.depth === 2) parent = i;
      if (t.text.toLowerCase().includes(needle)) {
        keep.add(i);
        if (t.depth === 3 && parent >= 0) keep.add(parent);
      }
    });
    return toc.filter((_, i) => keep.has(i));
  }, [q, toc]);

  return (
    <>
      <h2>In this guide</h2>
      <label className="sr-only" htmlFor="admin-toc-filter">Filter sections</label>
      <input
        id="admin-toc-filter"
        className="toc-search"
        type="search"
        placeholder="Filter sections…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul>
        {shown.map((t) => (
          <li key={t.id} className={t.depth === 3 ? "d3" : undefined}>
            <a href={`#${t.id}`}>{t.text}</a>
          </li>
        ))}
        {!shown.length && <li className="faint" style={{ paddingLeft: 12 }}>No section matches.</li>}
      </ul>
    </>
  );
}
