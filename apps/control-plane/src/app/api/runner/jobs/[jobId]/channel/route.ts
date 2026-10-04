import { handleChannel } from "../../../../../../runner-api/handlers.ts";
import { notConfigured, runnerApiDeps } from "../../../../../../server/runner-api.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const deps = runnerApiDeps();
  return deps ? handleChannel(request, (await params).jobId, deps) : notConfigured();
}
