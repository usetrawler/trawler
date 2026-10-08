import { getAuth } from "../../../server/auth.ts";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const auth = getAuth();
  return auth.mcp ? auth.handler(request) : new Response(null, { status: 404 });
}
export const HEAD = GET;
