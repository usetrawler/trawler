import type { Tx } from "../db/tenancy.ts";
import { last4, type Keyring } from "../lib/secrets.ts";
import { customUrlProblem, PROVIDERS, type Provider } from "../llm/providers.ts";

const context = (orgId: string) => [orgId, "credentials", "llm", "key"];
const legacyContext = (orgId: string) => [orgId, "credentials", "openrouter", "key"];
const KEY = /^[A-Za-z0-9._-]{20,400}$/;

export const keyLooksValid = (key: string) => KEY.test(key);

export interface StoredKey {
  provider: Provider;
  key: string;
  baseUrl: string | null;
}

export interface KeyHint {
  provider: Provider;
  hint: string;
  baseUrl: string | null;
}

export async function setModelKey(tx: Tx, orgId: string, input: { provider: Provider; key: string; baseUrl?: string | null }, userId: string, keys: Keyring): Promise<void> {
  if (!PROVIDERS.includes(input.provider)) throw new Error("unknown provider");
  if (!KEY.test(input.key)) throw new Error("that does not look like an API key");
  const baseUrl = input.provider === "custom" ? input.baseUrl ?? "" : null;
  if (baseUrl !== null && customUrlProblem(baseUrl)) throw new Error(customUrlProblem(baseUrl)!);
  const values = { kind: input.provider, base_url: baseUrl, secret: keys.encrypt(input.key, context(orgId)), hint: last4(input.key), created_by: userId, created_at: new Date() };
  await tx
    .insertInto("credentials")
    .values({ org_id: orgId, ...values })
    .onConflict((oc) => oc.column("org_id").doUpdateSet(values))
    .execute();
}

export async function modelKeyHint(tx: Tx, orgId: string): Promise<KeyHint | null> {
  const row = await tx.selectFrom("credentials").select(["kind", "hint", "base_url"]).where("org_id", "=", orgId).executeTakeFirst();
  return row ? { provider: row.kind as Provider, hint: row.hint, baseUrl: row.base_url } : null;
}

export interface KeyDetails extends KeyHint {
  addedBy: string;
  addedAt: Date;
}

export async function modelKeyDetails(tx: Tx, orgId: string): Promise<KeyDetails | null> {
  const row = await tx.selectFrom("credentials").select(["kind", "hint", "base_url", "created_by", "created_at"]).where("org_id", "=", orgId).executeTakeFirst();
  return row ? { provider: row.kind as Provider, hint: row.hint, baseUrl: row.base_url, addedBy: row.created_by, addedAt: row.created_at } : null;
}

export async function removeModelKey(tx: Tx, orgId: string): Promise<boolean> {
  const { numDeletedRows } = await tx.deleteFrom("credentials").where("org_id", "=", orgId).executeTakeFirst();
  return numDeletedRows > 0n;
}

export async function modelKey(tx: Tx, orgId: string, keys: Keyring): Promise<StoredKey | null> {
  const row = await tx.selectFrom("credentials").select(["kind", "secret", "base_url"]).where("org_id", "=", orgId).executeTakeFirst();
  if (!row) return null;
  let key: string;
  try {
    key = keys.decrypt(row.secret, context(orgId));
  } catch (err) {
    if (row.kind !== "openrouter") throw err;
    key = keys.decrypt(row.secret, legacyContext(orgId));
  }
  return { provider: row.kind as Provider, key, baseUrl: row.base_url };
}
