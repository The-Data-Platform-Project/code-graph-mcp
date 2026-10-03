import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DocsShell from "@/components/site/DocsShell";
import { DOCS, DOCS_NAV, docBySlug, pagerFor } from "@/lib/docs";
import { renderDoc } from "@/lib/markdown";

// Every doc is known at build time; anything else is a 404, never a render.
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS.map((d) => ({ slug: d.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = docBySlug((await params).slug);
  if (!doc) return {};
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: `/docs/${doc.slug}` },
    openGraph: { title: doc.title, description: doc.description, url: `/docs/${doc.slug}` },
  };
}

export default async function DocPage({ params }: Props) {
  const doc = docBySlug((await params).slug);
  if (!doc) notFound();
  const { html, toc } = renderDoc(doc.body);
  const href = `/docs/${doc.slug}`;
  return (
    <DocsShell
      nav={DOCS_NAV}
      current={href}
      eyebrow="Documentation"
      title={doc.title}
      description={doc.description}
      html={html}
      toc={toc}
      pager={pagerFor(href)}
    />
  );
}
