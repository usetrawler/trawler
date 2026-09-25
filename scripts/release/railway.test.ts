import { expect, test } from "vitest";
import { railway, serviceVariable, target } from "./railway.ts";

type Body = { query: string; variables: Record<string, unknown> };

function fakeRailway(reply: (body: Body) => { status?: number; body: unknown }) {
  const seen: Array<{ token: string | null; body: Body }> = [];
  const fakeFetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    seen.push({ token: new Headers(init?.headers).get("project-access-token"), body });
    const { status = 200, body: payload } = reply(body);
    return new Response(JSON.stringify(payload), { status });
  }) as typeof globalThis.fetch;
  return { seen, fetch: fakeFetch };
}

test("reads one variable of a named service in the token's own project and environment", async () => {
  const fake = fakeRailway(({ query }) => {
    if (query.includes("projectToken")) return { body: { data: { projectToken: { projectId: "p-core", environmentId: "e-production", environment: { name: "production" } } } } };
    if (query.includes("services")) return { body: { data: { project: { services: { edges: [{ node: { id: "s-cp", name: "control-plane" } }] } } } } };
    return { body: { data: { variables: { TRAWLER_SMOKE_TOKEN: "smoke-token" } } } };
  });
  const api = railway("core-token", fake.fetch);
  const at = await target(api);
  expect(at.environmentName).toBe("production");
  expect(await serviceVariable(api, at, "control-plane", "TRAWLER_SMOKE_TOKEN")).toBe("smoke-token");
  expect(fake.seen.at(-1)!.body.variables).toEqual({ proj: "p-core", env: "e-production", svc: "s-cp" });
  expect(fake.seen.every((c) => c.token === "core-token")).toBe(true);
});

test("an error Railway reports is thrown with Railway's own words, even next to partial data", async () => {
  const refused = railway("t", fakeRailway(() => ({ body: { data: { projectToken: null }, errors: [{ message: "Project Token not found" }] } })).fetch);
  await expect(refused.query("query { projectToken { projectId } }")).rejects.toThrow("Railway answered HTTP 200: Project Token not found");
  const down = railway("t", fakeRailway(() => ({ status: 502, body: {} })).fetch);
  await expect(down.query("query { projectToken { projectId } }")).rejects.toThrow("Railway answered HTTP 502: no data");
});
