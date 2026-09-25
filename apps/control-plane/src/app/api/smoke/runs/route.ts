import { smokeDeps } from "../../../../server/smoke.ts";
import { handleSmokeStart } from "../../../../smoke/smoke.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleSmokeStart(request, smokeDeps());
}
