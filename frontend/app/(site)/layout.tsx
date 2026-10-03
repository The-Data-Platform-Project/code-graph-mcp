import "@/styles/site.css";
import SiteFooter from "@/components/site/SiteFooter";
import SiteHeader from "@/components/site/SiteHeader";

/** Marketing pages, public docs and the admin guide: the ContextForge site shell. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="cf">
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </div>
  );
}
