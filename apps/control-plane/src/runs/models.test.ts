import { expect, test } from "vitest";
import { estimateUsd, RUN_MODELS } from "./models.ts";

test("the estimate grows with people and model price", () => {
  const [cheap, , strong] = RUN_MODELS;
  const one = estimateUsd(cheap!, 1);
  expect(one.low).toBeLessThan(one.high);
  expect(estimateUsd(cheap!, 4).high).toBeCloseTo(one.high * 4, 10);
  expect(estimateUsd(strong!, 1).high).toBeGreaterThan(one.high);
});
