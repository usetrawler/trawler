import type { NextRequest } from "next/server";
import { getAuth } from "../../../../server/auth.ts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return getAuth().handler(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return getAuth().handler(request);
}
