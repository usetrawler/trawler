import { runApiDeps } from "../../../../../../run-api/deps.ts";
import { handleStopRun } from "../../../../../../run-api/handlers.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleStopRun(request, (await params).id, runApiDeps());
}
