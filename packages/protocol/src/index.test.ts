import { expect, test } from "vitest";

test("workspace loads", async () => {
  await expect(import("./index.ts")).resolves.toBeDefined();
});
