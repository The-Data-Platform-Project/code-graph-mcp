"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/brand/Logo";
import { APP_PATH, HEADER_NAV, type NavLink } from "@/lib/site";

function isCurrent(pathname: string, href: string): boolean {
  if (href.startsWith("http") || href.includes("#")) return false;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavItem({ link, pathname }: { link: NavLink; pathname: string }) {
  if (link.external) {
    return (
      <a href={link.href} className="ext" rel="noopener noreferrer" target="_blank">
        {link.label}
      </a>
    );
  }
  return (
    <Link href={link.href} aria-current={isCurrent(pathname, link.href) ? "page" : undefined}>
      {link.label}
    </Link>
  );
}

export default function SiteHeader() {
  const pathname = usePathname() ?? "/";
  return (
    <header className="site-header">
      <a className="skip" href="#main">Skip to content</a>
      <div className="container bar">
        <Link href="/" aria-label="ContextForge home">
          <Logo id="hdr" size={30} />
        </Link>
        <nav className="site-nav" aria-label="Main">
          {HEADER_NAV.map((l) => (
            <NavItem key={l.href} link={l} pathname={pathname} />
          ))}
        </nav>
        <div className="header-cta">
          {/* A plain link: the app has its own stylesheet, so load it fresh. */}
          <a className="btn btn-primary btn-sm" href={APP_PATH}>Launch app</a>
        </div>
        {/* Keyed on the path so the menu closes after navigating. No JS needed to open it. */}
        <details className="mobile-nav" key={pathname}>
          <summary aria-label="Menu">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </summary>
          <nav className="panel" aria-label="Mobile">
            {HEADER_NAV.map((l) => (
              <NavItem key={l.href} link={l} pathname={pathname} />
            ))}
            <a className="btn btn-primary" href={APP_PATH}>Launch app</a>
          </nav>
        </details>
      </div>
    </header>
  );
}
