import { handleEvents } from "../../../../../runner-api/handlers.ts";
import { notConfigured, runnerApiDeps } from "../../../../../server/runner-api.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const deps = runnerApiDeps();
  return deps ? handleEvents(request, (await params).id, deps) : notConfigured();
}
