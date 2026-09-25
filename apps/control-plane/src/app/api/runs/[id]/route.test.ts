import type { NextRequest } from "next/server";
import { expect, test, vi } from "vitest";

vi.mock("../../../../server/runs.ts", () => ({ runFor: async () => ({ signedIn: false }) }));

const { GET } = await import("./route.ts");

test("a session that no longer belongs to any workspace is answered as signed out", async () => {
  const res = await GET(new Request("http://localhost:3000/api/runs/0f8fad5b-d9cb-469f-a165-70867728950e") as NextRequest, { params: Promise.resolve({ id: "0f8fad5b-d9cb-469f-a165-70867728950e" }) });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "sign in" });
});
