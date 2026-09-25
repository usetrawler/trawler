import { expect, test } from "vitest";
import { estimateUsd, type RunModel } from "./models.ts";

const cheap: RunModel = { id: "c", label: "C", note: null, promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 };
const strong: RunModel = { id: "s", label: "S", note: null, promptUsdPerMtok: 3, completionUsdPerMtok: 15 };

test("the estimate grows with people and model price", () => {
  const one = estimateUsd(cheap, 1);
  expect(one.low).toBeLessThan(one.high);
  expect(one.high).toBeCloseTo(60 * (10_000 * 0.3 + 300 * 1.2) / 1e6, 10);
  expect(estimateUsd(cheap, 4).high).toBeCloseTo(one.high * 4, 10);
  expect(estimateUsd(strong, 1).high).toBeGreaterThan(one.high);
});
