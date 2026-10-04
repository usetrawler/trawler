import type { NextRequest } from "next/server";
import { openArtifact } from "../../../../artifacts/artifacts.ts";
import { artifactStore } from "../../../../server/artifacts.ts";
import { signedInMember } from "../../../../server/auth.ts";
import { getDb } from "../../../../server/db.ts";
import { logError } from "../../../../server/log.ts";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const member = await signedInMember(request.headers);
  if (!member) return Response.json({ error: "sign in" }, { status: 401, headers: { "cache-control": "no-store" } });
  const store = artifactStore();
  if (!store) return notFound();
  const id = (await params).id;
  const file = await openArtifact(getDb(), store, member.orgId, id).catch(async (err: unknown) => {
    await logError("a screen capture could not be read from the bucket", { orgId: member.orgId, artifactId: id, err });
    return "unavailable" as const;
  });
  if (file === "unavailable") return Response.json({ error: "try again" }, { status: 502, headers: { "cache-control": "no-store" } });
  if (!file) return notFound();
  return new Response(file.body, {
    headers: { "content-type": file.contentType, "content-length": String(file.size), "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}
