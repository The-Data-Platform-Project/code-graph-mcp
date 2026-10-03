import "@/styles/site.css";
import Link from "next/link";
import { Logo } from "@/components/brand/Logo";

export default function NotFound() {
  return (
    <div className="cf">
      <main id="main" className="nf">
        <div className="inner">
          <Logo id="nf" size={40} />
          <p className="eyebrow">404</p>
          <h1 className="h2">This page does not exist.</h1>
          <p className="muted">It may have moved, or the link is mistyped.</p>
          <div className="hero-ctas">
            <Link className="btn btn-primary" href="/">Home</Link>
            <Link className="btn btn-ghost" href="/docs">Documentation</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
