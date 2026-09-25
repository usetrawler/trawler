import type { Tx } from "../db/tenancy.ts";
import { last4, type Keyring } from "../lib/secrets.ts";

const KIND = "openrouter";
const context = (orgId: string) => [orgId, "credentials", KIND, "key"];
const KEY = /^[A-Za-z0-9._-]{20,300}$/;

export type KeyCheck = "ok" | "invalid" | "unavailable";

export async function checkOpenRouterKey(key: string, opts: { baseUrl: string; fetch?: typeof fetch }): Promise<KeyCheck> {
  if (!KEY.test(key)) return "invalid";
  try {
    const res = await (opts.fetch ?? fetch)(`${opts.baseUrl}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return "invalid";
    return res.ok ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function setOpenRouterKey(tx: Tx, orgId: string, key: string, userId: string, keys: Keyring): Promise<void> {
  if (!KEY.test(key)) throw new Error("that does not look like an OpenRouter key");
  const values = { secret: keys.encrypt(key, context(orgId)), hint: last4(key), created_by: userId, created_at: new Date() };
  await tx
    .insertInto("credentials")
    .values({ org_id: orgId, kind: KIND, ...values })
    .onConflict((oc) => oc.columns(["org_id", "kind"]).doUpdateSet(values))
    .execute();
}

export async function openRouterKeyHint(tx: Tx, orgId: string): Promise<string | null> {
  const row = await tx.selectFrom("credentials").select("hint").where("org_id", "=", orgId).where("kind", "=", KIND).executeTakeFirst();
  return row?.hint ?? null;
}

export async function openRouterKey(tx: Tx, orgId: string, keys: Keyring): Promise<string | null> {
  const row = await tx.selectFrom("credentials").select("secret").where("org_id", "=", orgId).where("kind", "=", KIND).executeTakeFirst();
  return row ? keys.decrypt(row.secret, context(orgId)) : null;
}
