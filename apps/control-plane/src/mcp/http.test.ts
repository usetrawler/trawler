import { expect, test } from "vitest";
import { canonicalOrigin, mcpResource } from "./config.ts";
import { boundedBody } from "./http.ts";

test("only a configured origin can identify a resource", () => {
  expect(mcpResource("https://app.usetrawler.com/")).toBe("https://app.usetrawler.com/api/mcp");
  for (const value of ["http://app.usetrawler.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?host=x", "https://example.com/#x"]) {
    expect(() => canonicalOrigin(value)).toThrow();
  }
});

test("both declared and streamed oversized bodies are stopped before parsing", async () => {
  const declared = await boundedBody(new Request("http://localhost", { method: "POST", headers: { "Content-Length": "100000" }, body: "x" }));
  expect((declared as Response).status).toBe(413);
  const streamed = await boundedBody(new Request("http://localhost", { method: "POST", body: "x".repeat(65537) }));
  expect((streamed as Response).status).toBe(413);
  expect(await boundedBody(new Request("http://localhost", { method: "POST", body: "small" }))).toBe("small");
});
