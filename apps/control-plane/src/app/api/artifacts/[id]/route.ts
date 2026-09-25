import type { NextRequest } from "next/server";
import { artifactLink } from "../../../../artifacts/artifacts.ts";
import { artifactStore } from "../../../../server/artifacts.ts";
import { getAuth } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "sign in" }, { status: 401, headers: { "cache-control": "no-store" } });
  const orgId = session.session.activeOrganizationId;
  const store = artifactStore();
  if (!orgId || !store) return notFound();
  const link = await artifactLink(getDb(), store, orgId, (await params).id);
  return link ? new Response(null, { status: 302, headers: { location: link, "cache-control": "private, no-store" } }) : notFound();
}
