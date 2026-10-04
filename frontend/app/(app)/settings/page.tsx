import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Settings from "@/components/Settings";
import { canAdminister, canManageTenant } from "@/lib/access";
import { getViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Settings",
  robots: { index: false, follow: false },
};

export default async function SettingsPage() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login?next=/settings");
  return (
    <Settings
      tenantName={viewer.tenant.displayName}
      githubLogin={viewer.githubLogin}
      canManage={canManageTenant(viewer)}
      isAdmin={canAdminister(viewer)}
    />
  );
}
