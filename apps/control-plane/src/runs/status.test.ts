import { expect, test } from "vitest";
import { runPath, runTitle } from "./status.ts";

test("a run's address carries its number padded like its title", () => {
  expect([runPath(3), runTitle(3)]).toEqual(["/runs/0003", "Run 0003"]);
  expect(runPath(17)).toBe("/runs/0017");
  expect(runPath(12345)).toBe("/runs/12345");
});
