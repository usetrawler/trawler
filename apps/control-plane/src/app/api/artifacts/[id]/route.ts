import type { NextRequest } from "next/server";
import { artifactLink } from "../../../../artifacts/artifacts.ts";
import { artifactStore } from "../../../../server/artifacts.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = await signedInMember(request.headers);
  if (!member) return Response.json({ error: "sign in" }, { status: 401, headers: { "cache-control": "no-store" } });
  const store = artifactStore();
  if (!store) return notFound();
  const link = await artifactLink(getDb(), store, member.orgId, (await params).id);
  return link ? new Response(null, { status: 302, headers: { location: link, "cache-control": "private, no-store" } }) : notFound();
}
