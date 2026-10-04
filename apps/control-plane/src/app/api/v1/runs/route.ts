import { runApiDeps } from "../../../../run-api/deps.ts";
import { handleStartRun } from "../../../../run-api/handlers.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleStartRun(request, runApiDeps());
}
