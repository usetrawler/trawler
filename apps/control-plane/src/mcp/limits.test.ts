import { expect, test } from "vitest";
import { refusalFor, spendLimitFrom, usageOf, type WindowRun } from "./limits.ts";

const T0 = new Date("2026-10-01T10:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);
const run = (hours: number, over: Partial<WindowRun> = {}): WindowRun => ({ startedAt: at(hours), live: false, budgetUsd: 2, costUsd: 0.5, ...over });

test("the limit chosen at consent is read as whole runs and dollars within the bounds, and defaults fill what is missing", () => {
  expect(spendLimitFrom({})).toBeNull();
  expect(spendLimitFrom({ max_runs: 3, max_spend_usd: "12.345" })).toEqual({ runsPerDay: 3, spendUsdPerDay: 12.35 });
  expect(spendLimitFrom({ max_runs: 3 })).toEqual({ runsPerDay: 3, spendUsdPerDay: 20 });
  for (const bad of [{ max_runs: 0 }, { max_runs: 51 }, { max_runs: 2.5 }, { max_runs: "x" }, { max_spend_usd: 0.5 }, { max_spend_usd: 501 }, { max_spend_usd: "NaN" }, { max_spend_usd: null }]) expect(spendLimitFrom(bad)).toBe("invalid");
});

test("a live run holds its cap, a finished one holds what it cost, and both count as a start", () => {
  const usage = usageOf([run(0, { live: true, budgetUsd: 3 }), run(1, { costUsd: 0.25 })], { runsPerDay: 5, spendUsdPerDay: 20 });
  expect(usage).toMatchObject({ runs: 2, spentUsd: 3.25, runsFreeAt: null });
});

test("a start is refused at the runs limit, naming the limit and when the oldest start leaves the window", () => {
  const refused = refusalFor([run(0), run(2), run(4)], { runsPerDay: 3, spendUsdPerDay: 100 }, 1)!;
  expect(refused.limit).toBe("runs");
  expect(refused.message).toContain("3 runs in 24 hours and has started 3");
  expect(refused.message).toContain(at(24).toISOString());
  expect(refusalFor([run(0), run(2)], { runsPerDay: 3, spendUsdPerDay: 100 }, 1)).toBeNull();
});

test("a cap that does not fit the allowance is refused with what is left and when enough frees up", () => {
  const runs = [run(0, { costUsd: 4 }), run(3, { costUsd: 4 })];
  const refused = refusalFor(runs, { runsPerDay: 10, spendUsdPerDay: 10 }, 5)!;
  expect(refused.limit).toBe("spend");
  expect(refused.message).toContain("$10.00 in 24 hours and $2.00 is left");
  expect(refused.message).toContain("cap of $5.00");
  expect(refused.message).toContain(at(24).toISOString());
  expect(refusalFor(runs, { runsPerDay: 10, spendUsdPerDay: 10 }, 2)).toBeNull();
});

test("a cap above the whole limit says so instead of promising it will free up", () => {
  const refused = refusalFor([], { runsPerDay: 10, spendUsdPerDay: 3 }, 5)!;
  expect(refused.limit).toBe("cap");
  expect(refused.message).toContain("Start it with a lower cap");
  expect(refused.message).not.toContain("frees up");
});
