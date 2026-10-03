import Link from "next/link";
import type { NavGroup } from "@/lib/docs";
import type { TocItem } from "@/lib/markdown";
import CopyCode from "./CopyCode";

type Pager = { prev: { href: string; label: string } | null; next: { href: string; label: string } | null };

function SideNav({ nav, current }: { nav: NavGroup[]; current: string }) {
  return (
    <>
      {nav.map((g) => (
        <div key={g.title}>
          <h2>{g.title}</h2>
          <ul>
            {g.items.map((it) => (
              <li key={it.href}>
                <Link href={it.href} aria-current={it.href === current ? "page" : undefined}>
                  {it.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

export function Toc({ toc }: { toc: TocItem[] }) {
  if (!toc.length) return null;
  return (
    <>
      <h2>On this page</h2>
      <ul>
        {toc.map((t) => (
          <li key={t.id} className={t.depth === 3 ? "d3" : undefined}>
            <a href={`#${t.id}`}>{t.text}</a>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The documentation layout: section navigation, the page, and its outline.
 * Shared by the public docs and the admin guide, which pass their own nav.
 */
export default function DocsShell({
  nav,
  navLabel = "Documentation",
  current,
  eyebrow,
  title,
  description,
  html,
  toc,
  tocSlot,
  pager,
  before,
  children,
}: {
  nav: NavGroup[];
  navLabel?: string;
  current: string;
  eyebrow?: string;
  title: string;
  description?: string;
  html?: string;
  toc?: TocItem[];
  /** Replaces the default outline (the admin guide adds a filter box). */
  tocSlot?: React.ReactNode;
  pager?: Pager;
  before?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const hasToc = Boolean(tocSlot) || Boolean(toc && toc.length);
  return (
    <div className={`container docs${hasToc ? "" : " no-toc"}`}>
      <aside className="docs-side">
        <nav aria-label={navLabel}>
          <SideNav nav={nav} current={current} />
        </nav>
      </aside>

      <article>
        <details className="docs-mobile">
          <summary>{navLabel}</summary>
          <nav aria-label={`${navLabel} (mobile)`}>
            <SideNav nav={nav} current={current} />
          </nav>
        </details>

        <header className="doc-head">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </header>
        {before}
        {html && <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />}
        {children}

        {pager && (pager.prev || pager.next) && (
          <nav className="doc-pager" aria-label="Previous and next">
            {pager.prev && (
              <Link href={pager.prev.href}>
                <span>Previous</span>
                <b>{pager.prev.label}</b>
              </Link>
            )}
            {pager.next && (
              <Link href={pager.next.href} className="next">
                <span>Next</span>
                <b>{pager.next.label}</b>
              </Link>
            )}
          </nav>
        )}
      </article>

      {hasToc && <aside className="docs-toc">{tocSlot ?? <Toc toc={toc!} />}</aside>}
      <CopyCode />
    </div>
  );
}
