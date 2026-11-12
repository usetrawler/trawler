import { expect, test } from "vitest";
import { coverageOf } from "./coverage.ts";

test("a goal is checked when it was reached or the product stopped the person; the setup, the person, no answer or a failure with no cause (an older runner) leave it unchecked", () => {
  const c = coverageOf([
    { goal: "reached", status: "reached", blockedBy: null },
    { goal: "product", status: "failed", blockedBy: "product" },
    { goal: "setup", status: "failed", blockedBy: "setup" },
    { goal: "person", status: "failed", blockedBy: "person" },
    { goal: "no cause", status: "failed", blockedBy: null },
    { goal: "no answer", status: null, blockedBy: null },
    { goal: "skipped", status: "not_attempted", blockedBy: null },
  ]);
  expect(c).toEqual({
    total: 7, checked: 2, reached: 1, failedOnProduct: 1, notChecked: { setup: 1, person: 1, unknown: 1, other: 2 },
    unchecked: [{ goal: "setup", cause: "setup" }, { goal: "person", cause: "person" }, { goal: "no cause", cause: "unknown" }, { goal: "no answer", cause: "other" }, { goal: "skipped", cause: "other" }],
  });
});
