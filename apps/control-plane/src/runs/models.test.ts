import { expect, test } from "vitest";
import { estimateUsd } from "./models.ts";

test("the estimate grows with people and model price", () => {
  const cheap = { promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 };
  const one = estimateUsd(cheap, 1);
  expect(one.low).toBeLessThan(one.high);
  expect(one.high).toBeCloseTo((60 * (10_000 * 0.3 + 300 * 1.2)) / 1e6, 10);
  expect(estimateUsd(cheap, 4).high).toBeCloseTo(one.high * 4, 10);
  expect(estimateUsd({ promptUsdPerMtok: 3, completionUsdPerMtok: 15 }, 1).high).toBeGreaterThan(one.high);
});
