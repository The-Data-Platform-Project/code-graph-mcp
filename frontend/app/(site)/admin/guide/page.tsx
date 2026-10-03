import type { Metadata } from "next";
import AdminToc from "@/components/site/AdminToc";
import DocsShell from "@/components/site/DocsShell";
import { requireAdmin } from "@/lib/access";
import { ADMIN_GUIDE_MD } from "@/lib/admin-guide";
import { renderDoc } from "@/lib/markdown";
import { APP_PATH } from "@/lib/site";

// Rendered per request, after the authorization check: never prerendered into
// a static file, never cached for someone else.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Admin guide",
  robots: { index: false, follow: false },
};

export default async function AdminGuidePage() {
  // middleware.ts has already required a valid session; this is the
  // per-request authorization check. It redirects or 404s; it never returns
  // for anyone who may not administer.
  const viewer = await requireAdmin("/admin/guide");

  const { html, toc } = renderDoc(ADMIN_GUIDE_MD);
  const sections = toc.filter((t) => t.depth === 2);
  const nav = [
    {
      title: "Admin guide",
      items: sections.map((s) => ({ href: `#${s.id}`, label: s.text })),
    },
    {
      title: "User documentation",
      items: [
        { href: "/docs/user-guide", label: "User guide" },
        { href: "/docs/troubleshooting", label: "Troubleshooting" },
      ],
    },
  ];

  return (
    <DocsShell
      nav={nav}
      navLabel="Admin guide"
      current=""
      eyebrow="Administration"
      title="Admin guide"
      description="Running ContextForge: deployment, repositories, access, and day-to-day operations."
      html={html}
      tocSlot={<AdminToc toc={toc} />}
      before={
        <div className="admin-banner" role="note">
          <span className="badge badge-partial">Owner only</span>
          <span>
            Signed in as <b>{viewer.sub}</b> ({viewer.tenant.displayName}). Examples use
            placeholders in angle brackets; never paste real secrets into documentation.
          </span>
          {/* Plain link: the explorer loads its own stylesheet. */}
          <a className="link-arrow" href={APP_PATH}>Open the explorer</a>
        </div>
      }
    />
  );
}
