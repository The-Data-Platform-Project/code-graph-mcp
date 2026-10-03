import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Explorer from "@/components/Explorer";
import { canAdminister } from "@/lib/access";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Graph explorer",
  robots: { index: false, follow: false },
};

export default async function GraphPage() {
  // middleware.ts has checked the cookie; this resolves it to a viewer and
  // decides whether to offer the admin guide.
  const viewer = await getViewer();
  if (!viewer) redirect("/login?next=/graph");
  return <Explorer canAdminister={canAdminister(viewer)} />;
}
