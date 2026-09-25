import { handleClaim } from "../../../../runner-api/handlers.ts";
import { notConfigured, runnerApiDeps } from "../../../../server/runner-api.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const deps = runnerApiDeps();
  return deps ? handleClaim(request, deps) : notConfigured();
}
