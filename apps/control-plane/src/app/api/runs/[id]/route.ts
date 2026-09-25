import type { NextRequest } from "next/server";
import { runView } from "../../../../runs/report.ts";
import { runFor } from "../../../../server/runs.ts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const access = await runFor(request.headers, (await params).id);
  if (!access.signedIn) return Response.json({ error: "sign in" }, { status: 401 });
  if (!access.run) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ run: access.run, view: runView(access.run) }, { headers: { "cache-control": "no-store" } });
}
