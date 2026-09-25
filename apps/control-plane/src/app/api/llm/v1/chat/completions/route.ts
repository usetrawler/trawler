import { handleChatCompletions } from "../../../../../../llm-proxy/proxy.ts";
import { getDb, getKeyring } from "../../../../../../server/db.ts";
import { readEnv } from "../../../../../../server/env.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleChatCompletions(request, { db: getDb(), keys: getKeyring(), openRouterUrl: readEnv().openRouterUrl });
}
