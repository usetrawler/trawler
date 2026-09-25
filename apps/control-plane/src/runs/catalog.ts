import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../db/index.ts";
import { asSystem } from "../db/tenancy.ts";
import type { RunModel } from "./models.ts";

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const STALE_MS = 24 * 60 * 60 * 1000;

const Price = z.coerce.number().nonnegative().finite();
const OpenRouterModels = z.object({
  data: z.array(z.object({ id: z.string(), pricing: z.object({ prompt: Price, completion: Price, overrides: z.array(z.object({ prompt: Price, completion: Price })).optional() }).loose() }).loose()),
});

const toModel = (r: { id: string; label: string; note: string | null; prompt_usd_per_mtok: string; completion_usd_per_mtok: string }): RunModel => ({
  id: r.id, label: r.label, note: r.note, promptUsdPerMtok: Number(r.prompt_usd_per_mtok), completionUsdPerMtok: Number(r.completion_usd_per_mtok),
});

export async function runModels(db: Database): Promise<RunModel[]> {
  const rows = await asSystem(db, (tx) =>
    tx.selectFrom("model_catalog").select(["id", "label", "note", "prompt_usd_per_mtok", "completion_usd_per_mtok"]).where("enabled", "=", true).orderBy("recommended", "desc").orderBy("position").execute(),
  );
  return rows.map(toModel);
}

export async function runModel(db: Database, id: string): Promise<RunModel | null> {
  return (await runModels(db)).find((m) => m.id === id) ?? null;
}

export async function pricesAreStale(db: Database, now = Date.now()): Promise<boolean> {
  const { oldest } = await asSystem(db, (tx) => tx.selectFrom("model_catalog").select(sql<Date | null>`min(coalesce(prices_refreshed_at, 'epoch'))`.as("oldest")).where("enabled", "=", true).executeTakeFirstOrThrow());
  return !oldest || now - oldest.getTime() > STALE_MS;
}

export async function refreshPrices(db: Database, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(OPENROUTER_MODELS, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
  const { data } = OpenRouterModels.parse(await res.json());
  const byId = new Map(data.map((m) => [m.id, m.pricing]));
  return asSystem(db, async (tx) => {
    const catalog = await tx.selectFrom("model_catalog").select("id").execute();
    let updated = 0;
    for (const { id } of catalog) {
      const pricing = byId.get(id);
      if (!pricing) continue;
      const peak = (key: "prompt" | "completion") => Math.max(pricing[key], ...(pricing.overrides ?? []).map((o) => o[key])) * 1_000_000;
      await tx.updateTable("model_catalog").set({ prompt_usd_per_mtok: peak("prompt").toFixed(6), completion_usd_per_mtok: peak("completion").toFixed(6), prices_refreshed_at: new Date() }).where("id", "=", id).execute();
      updated++;
    }
    return updated;
  });
}

let refreshing: Promise<unknown> | undefined;

export function refreshPricesInBackground(db: Database): void {
  refreshing ??= pricesAreStale(db)
    .then((stale) => (stale ? refreshPrices(db) : 0))
    .catch((err: unknown) => console.error("model prices could not be refreshed", { message: err instanceof Error ? err.message : String(err) }))
    .finally(() => (refreshing = undefined));
}
