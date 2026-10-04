import { runApiDeps } from "../../../../../run-api/deps.ts";
import { handleGetRun } from "../../../../../run-api/handlers.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleGetRun(request, (await params).id, runApiDeps());
}
