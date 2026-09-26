import { expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ deps: null as unknown, calls: [] as unknown[][] }));
vi.mock("../../../../../server/runner-api.ts", async (importOriginal) => ({ ...(await importOriginal<object>()), runnerApiDeps: () => state.deps }));
vi.mock("../../../../../runner-api/handlers.ts", () => ({
  handleArtifactUpload: async (...args: unknown[]) => {
    state.calls.push(args);
    return new Response(null, { status: 201 });
  },
}));

const { POST } = await import("./route.ts");
const send = (id: string) => {
  const request = new Request(`http://cp.test/api/jobs/${id}/artifacts?kind=screenshot`, { method: "POST" });
  return { request, answer: POST(request, { params: Promise.resolve({ id }) }) };
};

test("without runners configured the upload answers 503; otherwise the job's upload goes to the handler with the runner deps", async () => {
  expect((await send("job-1").answer).status).toBe(503);
  expect(state.calls).toEqual([]);
  state.deps = { artifacts: "the store" };
  const { request, answer } = send("job-2");
  expect((await answer).status).toBe(201);
  expect(state.calls).toEqual([[request, "job-2", { artifacts: "the store" }]]);
});
