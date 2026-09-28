import { beforeEach, expect, test, vi } from "vitest";
import { openRouterPriceRange, parseEndpointPrices, resetPriceCache } from "./prices.ts";

const endpoints = (...pricing: Array<{ prompt: unknown; completion: unknown }>) => ({ data: { endpoints: pricing.map((p) => ({ pricing: p })) } });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => resetPriceCache());

test("the range runs from each side's cheapest provider to its dearest, per million tokens", () => {
  expect(parseEndpointPrices(endpoints(
    { prompt: "0.000000035", completion: "0.00000029" },
    { prompt: "0.000000375", completion: "0.0000006" },
    { prompt: "0.0000002", completion: "0.0000012" },
  ))).toEqual({
    low: { promptUsdPerMtok: expect.closeTo(0.035, 10), completionUsdPerMtok: expect.closeTo(0.29, 10) },
    high: { promptUsdPerMtok: expect.closeTo(0.375, 10), completionUsdPerMtok: expect.closeTo(1.2, 10) },
  });
});

test("providers without a usable price are left out, and a model with none has no range", () => {
  expect(parseEndpointPrices(endpoints({ prompt: "-1", completion: "0.000001" }, { prompt: "0.000001", completion: "0.000002" }))).toEqual({
    low: { promptUsdPerMtok: 1, completionUsdPerMtok: 2 },
    high: { promptUsdPerMtok: 1, completionUsdPerMtok: 2 },
  });
  expect(parseEndpointPrices(endpoints({ prompt: "free", completion: "0" }))).toBeNull();
  expect(parseEndpointPrices({ data: {} })).toBeNull();
});

test("a model's range is asked for by its path, kept for an hour, and asked again after a failure", async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(answer({}, 502))
    .mockResolvedValueOnce(answer(endpoints({ prompt: "0.0000001", completion: "0.0000002" })))
    .mockResolvedValueOnce(answer({}, 404));
  expect(await openRouterPriceRange("https://or.test/api/v1", "deepseek/deepseek-v4.1-flash", fetchImpl, 0)).toBeNull();
  expect(await openRouterPriceRange("https://or.test/api/v1", "deepseek/deepseek-v4.1-flash", fetchImpl, 0)).toBeNull();
  const range = await openRouterPriceRange("https://or.test/api/v1", "deepseek/deepseek-v4.1-flash", fetchImpl, 0);
  expect(range?.high).toEqual({ promptUsdPerMtok: expect.closeTo(0.1, 10), completionUsdPerMtok: expect.closeTo(0.2, 10) });
  expect(await openRouterPriceRange("https://or.test/api/v1", "deepseek/deepseek-v4.1-flash", fetchImpl, 59 * 60_000)).toBe(range);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(String(fetchImpl.mock.calls[2]![0])).toBe("https://or.test/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints");
  expect(await openRouterPriceRange("https://or.test/api/v1", "deepseek/deepseek-v4.1-flash", fetchImpl, 61 * 60_000)).toBeNull();
  expect(await openRouterPriceRange("https://or.test/api/v1", "deepseek/deepseek-v4.1-flash", fetchImpl, 62 * 60_000)).toBeNull();
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

test("a model name cannot leave the models path", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answer({}, 404));
  for (const model of ["a/../../keys", "./x", "a//b", "/a"]) expect(await openRouterPriceRange("https://or.test/api/v1", model, fetchImpl, 0)).toBeNull();
  expect(fetchImpl).not.toHaveBeenCalled();
  await openRouterPriceRange("https://or.test/api/v1", "a/b?x=1#y", fetchImpl, 0);
  expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://or.test/api/v1/models/a/b%3Fx%3D1%23y/endpoints");
});
