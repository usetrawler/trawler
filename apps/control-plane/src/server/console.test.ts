import { afterAll, expect, test } from "vitest";
import { envScrubber, scrubConsole } from "./log.ts";

const TOKEN = "t".repeat(40);
const original = console.error;
afterAll(() => {
  console.error = original;
});

test("whatever a library writes to the console passes the scrubber first: text, errors with their stack, and objects", () => {
  const written: unknown[][] = [];
  console.error = (...args: unknown[]) => void written.push(args);
  scrubConsole(envScrubber({ TRAWLER_RUNNER_TOKEN: TOKEN }));
  const failure = new Error(`request failed for ${TOKEN}`);
  console.error("⨯", failure, { authorization: `Bearer ${TOKEN}` }, 42);
  const [mark, error, object, number] = written[0]!;
  expect(mark).toBe("⨯");
  expect((error as Error).message).toBe("request failed for •••");
  expect((error as Error).stack).toContain("request failed for •••");
  expect((error as Error).stack).toContain("console.test.ts");
  expect(object).toContain("Bearer •••");
  expect(number).toBe(42);
  expect(JSON.stringify(written)).not.toContain(TOKEN);
});
