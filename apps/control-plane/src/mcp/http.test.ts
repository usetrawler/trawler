import { expect, test } from "vitest";
import { canonicalOrigin, mcpResource } from "./config.ts";
import { flowKey } from "./consent.ts";
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

test("a client published at an HTTPS URL is shown with its host, any other client with none", async () => {
  const { clientHostOf } = await import("./consent.ts");
  expect(clientHostOf("https://claude.ai/oauth/claude-code-client-metadata")).toBe("claude.ai");
  expect(clientHostOf("https://app.example.test:8443/client.json")).toBe("app.example.test:8443");
  expect(clientHostOf("http://localhost/client.json")).toBeNull();
  expect(clientHostOf("nnMeibKMlaEBeiLyTLtasgDsdwirexuD")).toBeNull();
  expect(clientHostOf(null)).toBeNull();
});

test("one signed authorization request has one flow key, however its parameters are ordered", () => {
  expect(flowKey("a=1&b=2&sig=x")).toBe(flowKey("sig=x&b=2&a=1"));
  expect(flowKey("a=1&b=2")).not.toBe(flowKey("a=1&b=3"));
  expect(flowKey("a=1&a=2")).not.toBe(flowKey("a=1"));
});
