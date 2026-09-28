import { expect, test } from "vitest";
import { estimateUsd, turnSteps } from "./models.ts";

test("a turn gets steps for each of its goals, up to the run's ceiling", () => {
  expect([1, 2, 4, 6].map((goals) => turnSteps(goals))).toEqual([30, 50, 90, 120]);
  expect(turnSteps(0)).toBe(30);
  expect(turnSteps(4, 60)).toBe(60);
});

test("a person with six goals has room for the 67 to 94 steps such a plan took on OrangeHRM", () => {
  expect(turnSteps(6)).toBeGreaterThanOrEqual(94);
});

test("the estimate spans the cheapest provider at typical steps to the dearest at every step allowed", () => {
  const cheapest = { promptUsdPerMtok: 0.035, completionUsdPerMtok: 0.29 };
  const dearest = { promptUsdPerMtok: 0.375, completionUsdPerMtok: 1.2 };
  const saucedemo = estimateUsd(cheapest, [6, 6, 6, 6], dearest);
  expect(saucedemo.low).toBeCloseTo((4 * 72 * (13_500 * 0.035 + 200 * 0.29)) / 1e6, 10);
  expect(saucedemo.high).toBeCloseTo((4 * 120 * (13_500 * 0.375 + 200 * 1.2)) / 1e6, 10);
  expect(saucedemo.low).toBeLessThan(1.06);
  expect(saucedemo.high).toBeGreaterThan(1.06);
  expect(saucedemo.perDefect).toBeCloseTo((15 * (13_500 * 0.375 + 200 * 1.2) + 6_000 * 0.375 + 150 * 1.2) / 1e6, 10);
});

test("with one price the estimate grows with turns, goals and price", () => {
  const price = { promptUsdPerMtok: 0.3, completionUsdPerMtok: 1.2 };
  const one = estimateUsd(price, [2]);
  expect(one.low).toBeLessThan(one.high);
  expect(estimateUsd(price, [2, 2, 2]).high).toBeCloseTo(one.high * 3, 10);
  expect(estimateUsd(price, [4]).high).toBeGreaterThan(one.high);
  expect(estimateUsd({ promptUsdPerMtok: 3, completionUsdPerMtok: 15 }, [2]).high).toBeGreaterThan(one.high);
});
