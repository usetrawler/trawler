import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import YAML from "yaml";
import { scriptedModel, text, toolCall } from "../../../packages/core/src/testing.ts";
import { runCli, type CliDeps } from "./cli.ts";

function deps(over: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const d: CliDeps = {
    env: { OPENROUTER_API_KEY: "sk-test" },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    model: () => scriptedModel([]),
    fetchText: async () => "<h1>Acme</h1>",
    openBrowser: async () => ({ tools: {}, fillField: async () => "typed", close: async () => {} }),
    runsRoot: mkdtempSync(join(tmpdir(), "runs-")),
    ...over,
  };
  return { d, out, err };
}

test("a missing OPENROUTER_API_KEY exits 2 with a clear message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, "p.yaml"), YAML.stringify({ name: "A", targetUrl: "https://a.test", personas: [{ id: "p", name: "P", brief: "b" }], goals: [{ id: "g", instruction: "x" }] }));
  for (const argv of [["setup", "https://a.test"], ["run", "--config", join(dir, "p.yaml")]]) {
    const { d, err } = deps({ env: { OPENROUTER_API_KEY: "  " } });
    expect(await runCli(argv, d)).toBe(2);
    expect(err.join("\n")).toMatch(/OPENROUTER_API_KEY is not set/);
  }
});

test("bad usage exits 2 with the usage text", async () => {
  for (const argv of [[], ["fly"], ["setup"], ["run"], ["run", "--config", "x.yaml", "--budget", "-1"], ["run", "--config", "x.yaml", "--max-steps", "2.5"], ["run", "--nope"]]) {
    const { d, err } = deps();
    expect(await runCli(argv, d)).toBe(2);
    expect(err.join("\n")).toContain("Usage:");
  }
});

test("an invalid project file exits 2 and names the problem", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, "p.yaml"), YAML.stringify({ name: "A", targetUrl: "ftp://a.test", personas: [], goals: [] }));
  const { d, err } = deps();
  expect(await runCli(["run", "--config", join(dir, "p.yaml")], d)).toBe(2);
  expect(err.join("\n")).toMatch(/targetUrl/);
});

test("setup writes a project file the run command accepts", async () => {
  const proposal = {
    name: "Acme", description: "Invoices.",
    personas: [{ id: "ana", name: "Ana", brief: "You invoice." }],
    goals: [{ id: "sign-up", instruction: "Get in." }],
  };
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const file = join(dir, "p.yaml");
  const { d, out } = deps({ model: () => scriptedModel([text(JSON.stringify(proposal))]) });
  expect(await runCli(["setup", "https://app.acme.test/", "-o", file], d)).toBe(0);
  expect(out.join("\n")).toMatch(/1 personas, 1 goals/);
  expect(YAML.parse(readFileSync(file, "utf8"))).toMatchObject({ name: "Acme", targetUrl: "https://app.acme.test/", allowedOrigins: ["https://app.acme.test"] });

  const agent = scriptedModel([toolCall("goal_status", { goal: "sign-up", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  const run = deps({ model: () => agent });
  expect(await runCli(["run", "--config", file, "--budget", "1"], run.d)).toBe(0);
  const [runDir] = readdirSync(run.d.runsRoot);
  const root = join(run.d.runsRoot, runDir!);
  expect(readdirSync(root).sort()).toEqual(["events.jsonl", "report.md", "summary.json"]);
  expect(readFileSync(join(root, "report.md"), "utf8")).toMatch(/# Acme[\s\S]*sign-up: reached/);
  expect(run.err.join("\n")).toMatch(/role:ana finished \(finish\)/);
});

test("an unreadable product page is an error, not a crash", async () => {
  const { d, err } = deps({ fetchText: async () => { throw new Error("HTTP 404"); } });
  expect(await runCli(["setup", "https://a.test/"], d)).toBe(1);
  expect(err.join("\n")).toMatch(/could not read https:\/\/a\.test\/: HTTP 404/);
});
