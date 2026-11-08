import { expect, test } from "vitest";
import { homeHeadline } from "./home-headline.ts";
import type { OpenFinding } from "./project-home.ts";

const from = (...sources: string[]): OpenFinding[] => sources.map((source, i) => ({ key: `k${i}`, title: "t", severity: "high", person: null, source, runNumber: i + 1, reportedAt: new Date() }));

test("the project's headline says how many confirmed defects are open and where they came from", () => {
  expect(homeHeadline([], 0, 0)).toBe("No runs yet.");
  expect(homeHeadline([], 4, 2)).toBe("No confirmed defects are open.");
  expect(homeHeadline([], 2, 0)).toBe("No run has completed yet.");
  expect(homeHeadline(from("PR #21"), 4, 2)).toBe("1 confirmed defect is open, from PR #21.");
  expect(homeHeadline(from("PR #21", "PR #22"), 4, 2)).toBe("2 confirmed defects are open, from PR #21 and PR #22.");
  expect(homeHeadline(from("PR #21", "PR #21", "Plan 1", "PR #9"), 4, 2)).toBe("4 confirmed defects are open, from PR #21, Plan 1 and PR #9.");
  expect(homeHeadline(from("PR #1", "PR #2", "PR #3", "Plan 1"), 4, 2)).toBe("4 confirmed defects are open, across 4 pull requests and plans.");
});
