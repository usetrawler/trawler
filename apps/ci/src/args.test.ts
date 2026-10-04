import { describe, expect, it } from "vitest";
import { parseCliArgs, UsageError } from "./args.ts";
import { decide } from "./decision.ts";
import type { RunResult } from "@usetrawler/protocol";

const PROJECT = "0b3a1f0e-6c43-4a53-9a2e-5d6d8c1f7a10";
const env = { TRAWLER_API_TOKEN: "trw_secret" };

describe("parseCliArgs", () => {
  it("applies defaults", () => {
    const parsed = parseCliArgs(["run", "--api", "https://staging.usetrawler.com/", "--project", PROJECT], env);
    expect(parsed).toEqual({
      help: false,
      options: { api: "https://staging.usetrawler.com", token: "trw_secret", project: PROJECT, plan: undefined, url: undefined, execution: "hosted", cap: undefined, model: undefined, failOn: "new-confirmed", timeoutMinutes: 45, comment: true },
    });
  });

  it("reads every flag and TRAWLER_API", () => {
    const parsed = parseCliArgs(["run", "--project", PROJECT, "--plan", PROJECT, "--url", "http://localhost:3000", "--runner", "own", "--cap", "2.5", "--model", "x/y", "--fail-on", "never", "--timeout-minutes", "10", "--no-comment"], { ...env, TRAWLER_API: "http://localhost:8080" });
    expect(parsed).toMatchObject({ options: { api: "http://localhost:8080", plan: PROJECT, url: "http://localhost:3000", execution: "own", cap: 2.5, model: "x/y", failOn: "never", timeoutMinutes: 10, comment: false } });
  });

  it.each([
    [["run", "--project", PROJECT], env, "--api"],
    [["run", "--api", "https://a.example"], env, "--project is required"],
    [["run", "--api", "https://a.example", "--project", "nope"], env, "UUID"],
    [["run", "--api", "https://a.example", "--project", PROJECT], {}, "TRAWLER_API_TOKEN"],
    [["run", "--api", "http://a.example", "--project", PROJECT], env, "https"],
    [["run", "--api", "https://a.example", "--project", PROJECT, "--runner", "cloud"], env, "--runner"],
    [["run", "--api", "https://a.example", "--project", PROJECT, "--fail-on", "sometimes"], env, "--fail-on"],
    [["run", "--api", "https://a.example", "--project", PROJECT, "--cap", "100"], env, "--cap"],
    [["run", "--api", "https://a.example", "--project", PROJECT, "--timeout-minutes", "0"], env, "--timeout-minutes"],
    [["build"], env, "unknown command"],
    [[], env, "no command"],
  ])("rejects %j", (argv, e, message) => {
    expect(() => parseCliArgs(argv, e)).toThrow(UsageError);
    expect(() => parseCliArgs(argv, e)).toThrow(message);
  });

  it("answers --help", () => {
    expect(parseCliArgs(["--help"], {})).toEqual({ help: true });
    expect(parseCliArgs(["run", "-h"], {})).toEqual({ help: true });
  });
});

const result = (over: Partial<RunResult>): RunResult => ({
  id: PROJECT, number: 7, status: "succeeded", finished: true, reportUrl: "https://app.example/runs/7", people: 2, goalsReached: 3, goalsTotal: 4,
  defects: { confirmed: 0, refuted: 0, inconclusive: 0 }, confirmed: [], costUsd: 1, commentMarkdown: "<!-- trawler-ci -->\nx", ...over,
});

describe("decide", () => {
  const withDefects = result({ defects: { confirmed: 2, refuted: 0, inconclusive: 0 } });

  it("fails on confirmed defects for new-confirmed and any-confirmed", () => {
    expect(decide(withDefects, "new-confirmed").exitCode).toBe(1);
    expect(decide(withDefects, "any-confirmed").exitCode).toBe(1);
  });

  it("passes with never, or when nothing is confirmed", () => {
    expect(decide(withDefects, "never").exitCode).toBe(0);
    expect(decide(result({}), "any-confirmed").exitCode).toBe(0);
  });

  it.each(["failed", "cancelled", "stopped_budget"] as const)("is neutral when the run ended as %s", (status) => {
    const decision = decide(result({ status, defects: { confirmed: 1, refuted: 0, inconclusive: 0 } }), "any-confirmed");
    expect(decision.exitCode).toBe(0);
    expect(decision.message).toContain("does not pass or fail");
  });
});
