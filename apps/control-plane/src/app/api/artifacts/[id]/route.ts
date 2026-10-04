import type { NextRequest } from "next/server";
import { openArtifact } from "../../../../artifacts/artifacts.ts";
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
  const file = await openArtifact(getDb(), store, member.orgId, (await params).id);
  if (!file) return notFound();
  return new Response(file.body, {
    headers: { "content-type": file.contentType, "content-length": String(file.size), "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
