import { afterEach, expect, test, vi } from "vitest";
import { writeLog } from "./log.ts";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-railway-request-id": "rr-7Ab" }) }));

afterEach(() => vi.restoreAllMocks());

test("a log line written while serving a request carries Railway's request id", async () => {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
  await writeLog("error", "judge again could not start", { orgId: "org-1" });
  expect(JSON.parse(lines[0]!)).toMatchObject({ request_id: "rr-7Ab", org_id: "org-1" });
});
