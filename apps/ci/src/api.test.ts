import { expect, it } from "vitest";
import { ApiError, runApi } from "./api.ts";

const ID = "0b3a1f0e-6c43-4a53-9a2e-5d6d8c1f7a10";

it("stops a run with a POST to its stop address and reads the answer", async () => {
  const seen: Array<{ method?: string; url: string; auth?: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ method: init?.method, url, auth: (init?.headers as Record<string, string>).authorization });
    return Response.json({ id: ID, status: "cancelled", stopped: true });
  }) as unknown as typeof fetch;
  const answer = await runApi("https://app.example", "trw_x", fetchImpl).stopRun(ID);
  expect(answer).toEqual({ id: ID, status: "cancelled", stopped: true });
  expect(seen).toEqual([{ method: "POST", url: `https://app.example/api/v1/runs/${ID}/stop`, auth: "Bearer trw_x" }]);
});

it("reports a server that answers a stop with something else", async () => {
  const fetchImpl = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
  await expect(runApi("https://app.example", "trw_x", fetchImpl).stopRun(ID)).rejects.toBeInstanceOf(ApiError);
});
