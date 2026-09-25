import { graphPayload } from "@/lib/graph";
import { json, withViewer } from "@/lib/handler";

export const dynamic = "force-dynamic";

export const GET = withViewer(async (viewer) => json(await graphPayload(viewer.tenant.schema)));
