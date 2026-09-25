import { smokeDeps } from "../../../../../server/smoke.ts";
import { handleSmokeStatus } from "../../../../../smoke/smoke.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleSmokeStatus(request, (await params).id, smokeDeps());
}
