import { expect, test } from "vitest";
import { originOf, viaLabel, viaOf } from "./via.ts";

const via = { kind: "mcp", client: "Claude Code", clientHost: "claude.ai", person: "Ana Lopez", grant: "g1" };

test("a stored origin is read back only when it is a complete MCP origin", () => {
  expect(viaOf(via)).toEqual({ kind: "mcp", client: "Claude Code", clientHost: "claude.ai", person: "Ana Lopez" });
  expect(viaOf({ ...via, clientHost: 4 })).toEqual({ kind: "mcp", client: "Claude Code", clientHost: null, person: "Ana Lopez" });
  for (const bad of [null, undefined, "mcp", 3, {}, { ...via, kind: "ui" }, { ...via, client: 1 }, { ...via, person: null }]) expect(viaOf(bad)).toBeNull();
});

test("a run came from the assistant, an API token or the app, in that order of evidence", () => {
  expect(originOf("mcp:g1:u1", via)).toBe("mcp");
  expect(originOf("api-token:t1", via)).toBe("mcp");
  expect(originOf("api-token:t1", null)).toBe("api");
  expect(originOf("u1", null)).toBe("app");
  expect(originOf("u1", { kind: "other" })).toBe("app");
  expect(originOf("mcp:g1:u1", null)).toBe("mcp");
});

test("the label names the assistant and the person", () => {
  expect(viaLabel(viaOf(via)!)).toBe("MCP · Claude Code (claude.ai) · Ana Lopez");
  expect(viaLabel({ ...viaOf(via)!, clientHost: null })).toBe("MCP · Claude Code · Ana Lopez");
});
