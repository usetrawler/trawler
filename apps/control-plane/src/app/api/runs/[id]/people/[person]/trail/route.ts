import type { NextRequest } from "next/server";
import { withOrg } from "../../../../../../../db/tenancy.ts";
import { personTrail } from "../../../../../../../runs/trail.ts";
import { signedInMember } from "../../../../../../../server/auth.ts";
import { getDb } from "../../../../../../../server/db.ts";
import { runIdFor } from "../../../../../../../server/runs.ts";

export const dynamic = "force-dynamic";

const CURSOR = /^[1-9]\d{0,14}$/;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; person: string }> }): Promise<Response> {
  const member = await signedInMember(request.headers);
  if (!member) return Response.json({ error: "sign in" }, { status: 401 });
  const { id, person } = await params;
  const before = new URL(request.url).searchParams.get("before");
  if (person.length < 1 || person.length > 100 || (before !== null && !CURSOR.test(before))) return Response.json({ error: "not found" }, { status: 404 });
  const runId = await runIdFor(member.orgId, id);
  const trail = runId && (await withOrg(getDb(), member.orgId, (tx) => personTrail(tx, member.orgId, runId, person, before === null ? undefined : Number(before))));
  if (!trail) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(trail, { headers: { "cache-control": "no-store" } });
}
