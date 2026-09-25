import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { SecretScrubber, scrubConsole } from "./secrets.ts";

const TOKEN = "t".repeat(40);
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
const original = { ...console };
let written: Array<[string, unknown[]]> = [];

beforeAll(() => {
  for (const level of LEVELS) console[level] = (...args: unknown[]) => void written.push([level, args]);
  const scrubber = new SecretScrubber();
  scrubber.add(TOKEN);
  scrubConsole(scrubber);
});

afterAll(() => Object.assign(console, original));

beforeEach(() => {
  written = [];
});

function failingFetch(): Error {
  return new Error("fetch failed", { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${TOKEN}.internal`), { code: "ENOTFOUND" }) });
}

test("every console level writes one line with the secrets masked", () => {
  for (const level of LEVELS) console[level](`retrying with ${TOKEN}`);
  expect(written).toEqual(LEVELS.map((level) => [level, ["retrying with •••"]]));
});

test("an error is written as Node writes it, with the stack of where it was thrown, its cause and code, and no secret", () => {
  console.error("⨯", failingFetch(), { authorization: `Bearer ${TOKEN}` }, 42);
  const [[level, [line]]] = written as [[string, [string]]];
  expect(level).toBe("error");
  expect(line).toMatch(/^⨯ Error: fetch failed\n\s+at failingFetch /);
  expect(line).toContain("[cause]: Error: getaddrinfo ENOTFOUND •••.internal");
  expect(line).toContain("code: 'ENOTFOUND'");
  expect(line).toContain("{ authorization: 'Bearer •••' } 42");
  expect(line).not.toContain(TOKEN);
});

test("format strings and nesting are as deep as Node prints them, not deeper", () => {
  console.log("%s saw", "ana@example.com", { nested: { deeper: { deepest: { token: TOKEN } } } });
  expect(written).toEqual([["log", ["ana@example.com saw { nested: { deeper: { deepest: [Object] } } }"]]]);
});

test("console.dir and console.dirxml, which Node writes without console.log, are masked too", () => {
  console.dir({ token: TOKEN });
  console.dirxml({ token: TOKEN });
  expect(written).toEqual([["log", ["{ token: '•••' }"]], ["log", ["{ token: '•••' }"]]]);
});
