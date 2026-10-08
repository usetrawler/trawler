import { describe, expect, test } from "vitest";
import { inputsHash } from "./pr-plan-store.ts";

describe("inputsHash", () => {
  const pr = { title: "Add export", description: "Adds an export.", changedFiles: ["a.ts", "b.ts"] };

  test("ignores spacing and the order of files", () => {
    expect(inputsHash({ ...pr, title: " Add  export ", changedFiles: ["b.ts", "a.ts"] })).toBe(inputsHash(pr));
  });

  test("changes when the described setup changes", () => {
    expect(inputsHash({ ...pr, environment: "Self-hosted." })).not.toBe(inputsHash(pr));
    expect(inputsHash({ ...pr, environment: "Self-hosted." })).toBe(inputsHash({ ...pr, environment: "  Self-hosted.\n" }));
  });
});
