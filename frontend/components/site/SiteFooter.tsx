import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { APP_PATH, FOOTER_GROUPS, SITE, type NavLink } from "@/lib/site";

function FooterLink({ link }: { link: NavLink }) {
  if (link.external) {
    return (
      <a href={link.href} className="ext" rel="noopener noreferrer" target="_blank">
        {link.label}
      </a>
    );
  }
  // The app loads its own stylesheet, so it gets a full page load.
  if (link.href === APP_PATH) return <a href={link.href}>{link.label}</a>;
  return <Link href={link.href}>{link.label}</Link>;
}

export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <Logo id="ftr" size={28} />
            <p>{SITE.name} — {SITE.tagline}</p>
          </div>
          {FOOTER_GROUPS.map((g) => (
            <div className="footer-col" key={g.title}>
              <h2>{g.title}</h2>
              <ul>
                {g.links.map((l) => (
                  <li key={l.href + l.label}>
                    <FooterLink link={l} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="footer-base">
          <span>Open source under the Apache License 2.0.</span>
          <span className="mono">Built on the code-graph-mcp project</span>
        </div>
      </div>
    </footer>
  );
}
