import { sql } from "kysely";
import { afterAll, expect, test } from "vitest";
import { testDb } from "../db/test-db.ts";
import { pricesAreStale, refreshPrices, refreshPricesInBackground, runModel, runModels } from "./catalog.ts";

const t = await testDb();
afterAll(() => t.drop());

const answer = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test("the seeded catalog lists the recommended model first", async () => {
  const models = await runModels(t.db);
  expect(models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4.1-flash", "google/gemini-3.5-flash", "anthropic/claude-haiku-4.5"]);
  expect(models[0]).toMatchObject({ label: "DeepSeek V4.1 Flash", note: "Recommended", promptUsdPerMtok: 0.3 });
  expect(await runModel(t.db, "openai/unlisted")).toBeNull();
});

test("prices refresh from OpenRouter at their peak, and unknown or disabled models are left alone", async () => {
  expect(await pricesAreStale(t.db)).toBe(true);
  const updated = await refreshPrices(t.db, answer({ data: [
    { id: "deepseek/deepseek-v4.1-flash", name: "x", pricing: { prompt: "0.00000015", completion: "0.0000006", overrides: [{ utc_days: ["monday"], prompt: "0.0000003", completion: "0.0000012" }] } },
    { id: "anthropic/claude-haiku-4.5", pricing: { prompt: "0.000002", completion: "0.00001", web_search: "0.01" } },
    { id: "someone/else", pricing: { prompt: "1", completion: "1" } },
    { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
  ] }));
  expect(updated).toBe(2);
  const models = await runModels(t.db);
  expect(models.find((m) => m.id === "anthropic/claude-haiku-4.5")).toMatchObject({ promptUsdPerMtok: 2, completionUsdPerMtok: 10 });
  expect(models.find((m) => m.id === "deepseek/deepseek-v4.1-flash")).toMatchObject({ promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 });
  expect(models.find((m) => m.id === "google/gemini-3.5-flash")).toMatchObject({ promptUsdPerMtok: 1.5 });
  expect(await pricesAreStale(t.db)).toBe(true);
  await sql`update model_catalog set enabled = false where id = 'google/gemini-3.5-flash'`.execute(t.db);
  expect(await pricesAreStale(t.db)).toBe(false);
  expect((await runModels(t.db)).map((m) => m.id)).not.toContain("google/gemini-3.5-flash");
  expect(await runModel(t.db, "google/gemini-3.5-flash")).toBeNull();
});

test("a failing list changes nothing, and bad catalog prices are skipped rather than stored as free", async () => {
  const before = await runModels(t.db);
  await expect(refreshPrices(t.db, answer({ error: "down" }, 503))).rejects.toThrow(/503/);
  const updated = await refreshPrices(t.db, answer({ data: [
    { id: "anthropic/claude-haiku-4.5", pricing: { prompt: null, completion: "" } },
    { id: "deepseek/deepseek-v4.1-flash", pricing: { prompt: "-1", completion: "x" } },
    { id: "google/gemini-3.5-flash", pricing: { prompt: "1", completion: "1" } },
  ] }));
  expect(updated).toBe(0);
  expect(await runModels(t.db)).toEqual(before);
});

test("background refreshes are attempted at most once an hour, even when a model can never be priced", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ data: [] })); }) as typeof fetch;
  try {
    const now = Date.now() + 10 * 24 * 60 * 60 * 1000;
    await refreshPricesInBackground(t.db, now);
    await refreshPricesInBackground(t.db, now + 60_000);
    expect(calls).toBe(1);
    await refreshPricesInBackground(t.db, now + 61 * 60_000);
    expect(calls).toBe(2);
  } finally {
    globalThis.fetch = original;
  }
});

test("the application role can read the catalog but never change it", async () => {
  await expect(t.db.transaction().execute(async (tx) => {
    await sql`set local role trawler_app`.execute(tx);
    await sql`update model_catalog set prompt_usd_per_mtok = 0`.execute(tx);
  })).rejects.toThrow(/permission denied/);
  const { rows } = await t.db.transaction().execute(async (tx) => {
    await sql`set local role trawler_app`.execute(tx);
    return sql<{ n: number }>`select count(*)::int as n from model_catalog`.execute(tx);
  });
  expect(rows[0]!.n).toBe(3);
});
