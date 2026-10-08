import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const src = new URL("..", import.meta.url).pathname;
const sources = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const callers = (call: string) => sources.filter((f) => readFileSync(`${src}${f}`, "utf8").includes(call)).sort();

test("a run started through the API or an assistant meets Start's refusals in one place, the service", () => {
  const outsideTheApp = callers("refusalToStart(").filter((f) => f.startsWith("run-api/") || f.startsWith("mcp/"));
  expect(outsideTheApp).toEqual(["run-api/service.ts"]);
});

test("an API token is made only where a person asks for one in Settings, never for a connection", () => {
  expect(callers("createApiToken(")).toEqual(["api-tokens/tokens.ts", "app/settings/actions.ts"]);
});
