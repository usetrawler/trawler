import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

type Version = [number, number, number];

function parse(version: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not an x.y.z version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare([a1, a2, a3]: Version, [b1, b2, b3]: Version): number {
  return a1 - b1 || a2 - b2 || a3 - b3;
}

function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  return range.split("||").some((clause) =>
    clause.trim().split(/\s+/).every((comparator) => {
      const match = /^(>=|<)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
      if (!match) throw new Error(`unsupported comparator in engines.node: ${comparator}`);
      const [, operator, major, minor = "0", patch = "0"] = match;
      const bound: Version = [Number(major), Number(minor), Number(patch)];
      return operator === ">=" ? compare(v, bound) >= 0 : compare(v, bound) < 0;
    }),
  );
}

const VULNERABLE_BROTLI_DECODER = ["24.0.0", "24.19.0", "24.22.0", "25.9.0", "26.0.0", "26.7.0", "26.12.0"];
const PATCHED_BROTLI_DECODER = ["24.22.1", "24.23.0", "26.12.1", "26.13.0", "27.0.0"];

describe("the Node floor keeps CVE-2026-111497 out", () => {
  const declared = JSON.parse(read("package.json")).engines.node as string;

  it.each(VULNERABLE_BROTLI_DECODER)("refuses %s", (version) => {
    expect(satisfies(version, declared)).toBe(false);
  });

  it.each(PATCHED_BROTLI_DECODER)("accepts %s", (version) => {
    expect(satisfies(version, declared)).toBe(true);
  });

  it("records the same range in the lockfile", () => {
    expect(JSON.parse(read("package-lock.json")).packages[""].engines.node).toBe(declared);
  });

  it("makes npm refuse an unpatched Node instead of warning", () => {
    expect(read(".npmrc").split("\n").map((line) => line.trim())).toContain("engine-strict=true");
  });

  it.each(["apps/control-plane/Dockerfile", "apps/runner/Dockerfile"])("has %s's install see that setting", (path) => {
    const dockerfile = read(path).split("\n");
    const install = dockerfile.findIndex((line) => /^RUN npm ci\b/.test(line));
    const stage = dockerfile.slice(0, install).findLastIndex((line) => /^FROM\b/.test(line));
    const copy = dockerfile.findIndex((line) => /^COPY\s+(\S+\s+)*\.npmrc\s+(\S+\s+)*\.\/$/.test(line));
    expect(install).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(stage);
    expect(copy).toBeLessThan(install);
  });
});
