import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import YAML from "yaml";
import { scriptedModel, text, toolCall } from "../../../packages/core/src/testing.ts";
import { fetchPage, runCli, type CliDeps } from "./cli.ts";

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

test("a broken YAML file exits 2 without printing its lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, "p.yaml"), "name: A\naccounts:\n  - ref: a\n    password: hunter22: secret\n");
  const { d, err } = deps();
  expect(await runCli(["run", "--config", join(dir, "p.yaml")], d)).toBe(2);
  expect(err.join("\n")).toMatch(/line 4/);
  expect(err.join("\n")).not.toContain("hunter22");
});

test("setup does not overwrite an existing project file unless forced", async () => {
  const proposal = { name: "Acme", description: "x", personas: [{ id: "ana", name: "Ana", brief: "b" }], goals: [{ id: "g", instruction: "Get in." }] };
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const file = join(dir, "p.yaml");
  writeFileSync(file, "keep: me\n");
  const first = deps({ model: () => scriptedModel([text(JSON.stringify(proposal))]) });
  expect(await runCli(["setup", "https://a.test/", "-o", file], first.d)).toBe(2);
  expect(first.err.join("\n")).toMatch(/already exists/);
  expect(readFileSync(file, "utf8")).toBe("keep: me\n");
  const forced = deps({ model: () => scriptedModel([text(JSON.stringify(proposal))]) });
  expect(await runCli(["setup", "https://a.test/", "-o", file, "--force"], forced.d)).toBe(0);
  expect(readFileSync(file, "utf8")).toContain("Acme");
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("an address that is not http(s) is a usage error", async () => {
  const { d } = deps();
  expect(await runCli(["setup", "ftp://a.test/"], d)).toBe(2);
});

test("a run in which every role failed exits 1 but still writes the report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, "p.yaml"), YAML.stringify({ name: "A", targetUrl: "https://a.test", personas: [{ id: "p", name: "P", brief: "b" }], goals: [{ id: "g", instruction: "x" }] }));
  const run = deps({ openBrowser: async () => { throw new Error("no chromium"); } });
  expect(await runCli(["run", "--config", join(dir, "p.yaml")], run.d)).toBe(1);
  const [runDir] = readdirSync(run.d.runsRoot);
  expect(readdirSync(join(run.d.runsRoot, runDir!))).toContain("report.md");
});

test("run passes --judge-model, --headed and the budget through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(dir, "p.yaml"), YAML.stringify({ name: "A", targetUrl: "https://a.test", personas: [{ id: "p", name: "P", brief: "b" }], goals: [{ id: "g", instruction: "x" }] }));
  const models: string[] = [];
  const headless: boolean[] = [];
  const agent = scriptedModel([toolCall("goal_status", { goal: "g", status: "reached", note: "" }), toolCall("finish", { summary: "done" })]);
  const run = deps({
    model: (id) => (models.push(id), agent),
    openBrowser: async (o) => (headless.push(o.headless), { tools: {}, fillField: async () => "typed", close: async () => {} }),
  });
  expect(await runCli(["run", "--config", join(dir, "p.yaml"), "--model", "m/a", "--judge-model", "m/j", "--headed"], run.d)).toBe(0);
  expect(models).toEqual(["m/a", "m/j"]);
  expect(headless).toEqual([false]);
  const [runDir] = readdirSync(run.d.runsRoot);
  expect(JSON.parse(readFileSync(join(run.d.runsRoot, runDir!, "summary.json"), "utf8"))).toMatchObject({ agentModel: "m/a", judgeModel: "m/j" });
  expect(await runCli(["run", "--config", join(dir, "p.yaml"), "--budget", "0"], deps().d)).toBe(2);
});

test("help works on every command", async () => {
  for (const argv of [["--help"], ["run", "--help"], ["setup", "--help"]]) {
    const { d, out } = deps();
    expect(await runCli(argv, d)).toBe(0);
    expect(out.join("\n")).toContain("Usage:");
  }
});

test("fetchPage stops reading at its size cap and refuses error pages", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/missing") {
      res.statusCode = 404;
      return res.end("nope");
    }
    res.setHeader("content-type", "text/html");
    const chunk = "a".repeat(64 * 1024);
    let sent = 0;
    const pump = () => {
      while (sent < 50 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      res.end();
    };
    res.on("close", () => (sent = Infinity));
    pump();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const page = await fetchPage(`http://127.0.0.1:${port}/big`);
    expect(page.length).toBeLessThanOrEqual(2_000_000);
    expect(page.length).toBeGreaterThan(1_000_000);
    await expect(fetchPage(`http://127.0.0.1:${port}/missing`)).rejects.toThrow(/HTTP 404/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
