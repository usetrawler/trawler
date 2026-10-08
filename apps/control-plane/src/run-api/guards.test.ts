import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const src = new URL("..", import.meta.url).pathname;
const sources = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const callers = (call: string) => sources.filter((f) => readFileSync(`${src}${f}`, "utf8").includes(call)).sort();

const callersOfStartRun = sources.filter((f) => /\bstartRun\(/.test(readFileSync(`${src}${f}`, "utf8"))).sort();

test("a run started through the API or an assistant is created in one place, the service, whose refusals and permissions every caller meets", () => {
  expect(callersOfStartRun).toEqual(["app/projects/[id]/actions.ts", "app/runs/[id]/actions.ts", "run-api/service.ts", "runs/runs.ts", "smoke/smoke.ts"]);
  expect(callers("refusalToStart(").filter((f) => f.startsWith("run-api/") || f.startsWith("app/api/") || f.startsWith("mcp/"))).toEqual(["run-api/service.ts"]);
});

test("an API token is made only where a person asks for one in Settings, never for a connection", () => {
  expect(callers("createApiToken(")).toEqual(["api-tokens/tokens.ts", "app/settings/actions.ts"]);
});
