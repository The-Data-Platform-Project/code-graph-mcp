import type { MetadataRoute } from "next";
import { DOCS } from "@/lib/docs";
import { SITE } from "@/lib/site";

/** Public pages only. The explorer, sign-in and admin guide are never listed. */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages: { path: string; priority: number }[] = [
    { path: "/", priority: 1 },
    { path: "/product", priority: 0.9 },
    { path: "/docs", priority: 0.9 },
    ...DOCS.map((d) => ({ path: `/docs/${d.slug}`, priority: 0.7 })),
    { path: "/roadmap", priority: 0.6 },
    { path: "/faq", priority: 0.6 },
  ];
  return pages.map(({ path, priority }) => ({
    url: `${SITE.url}${path === "/" ? "" : path}`,
    changeFrequency: "weekly",
    priority,
  }));
}
