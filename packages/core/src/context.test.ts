import { generateText, isStepCount, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { expect, test } from "vitest";
import { pruneMessages } from "./context.ts";
import { scriptedModel, text, toolCall } from "./testing.ts";

function result(id: string, toolName: string, value: string): ModelMessage {
  return { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }] };
}

function outputOf(m: ModelMessage | undefined) {
  return (m as { content: Array<{ output: { type: string; value?: unknown } }> }).content[0]!.output;
}

const big = "x".repeat(5000);
const opts = { keepLargeResults: 1, largeResultChars: 2000 };

test("keeps only the latest large result verbatim", () => {
  const msgs: ModelMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    result("1", "browser_snapshot", big),
    result("2", "browser_snapshot", big),
    result("3", "browser_snapshot", big),
  ];
  const values = pruneMessages(msgs, opts).slice(2).map((m) => outputOf(m).value);
  expect(values).toEqual(["[browser_snapshot result elided: 5000 chars]", "[browser_snapshot result elided: 5000 chars]", big]);
});

test("small results and non-tool messages are untouched", () => {
  const msgs: ModelMessage[] = [{ role: "user", content: big }, result("1", "note", "ok"), result("2", "browser_click", big)];
  const out = pruneMessages(msgs, opts);
  expect(out[0]).toEqual(msgs[0]);
  expect(out[1]).toEqual(msgs[1]);
  expect(outputOf(out[2]).value).toBe(big);
});

test("is idempotent and does not mutate its input", () => {
  const msgs: ModelMessage[] = [result("1", "browser_snapshot", big), result("2", "browser_snapshot", big)];
  const copy = structuredClone(msgs);
  const once = pruneMessages(msgs, opts);
  expect(pruneMessages(once, opts)).toEqual(once);
  expect(msgs).toEqual(copy);
});

test("measures json and content outputs by their serialized size", () => {
  const json: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "browser_navigate", output: { type: "json", value: { content: [{ type: "text", text: big }] } } }] };
  const content: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "browser_click", output: { type: "content", value: [{ type: "text", text: big }] } }] };
  const out = pruneMessages([json, content, result("3", "browser_snapshot", big)], opts);
  expect(outputOf(out[0]).value).toMatch(/^\[browser_navigate result elided: \d+ chars\]$/);
  expect(outputOf(out[1]).value).toMatch(/^\[browser_click result elided: \d+ chars\]$/);
});

test("keeps the last N when asked for more than one", () => {
  const msgs = [1, 2, 3, 4].map((n) => result(String(n), "browser_snapshot", big));
  const kept = pruneMessages(msgs, { keepLargeResults: 2, largeResultChars: 2000 }).filter((m) => outputOf(m).value === big);
  expect(kept).toHaveLength(2);
});

test("in a real agent loop the model sees one full snapshot, the latest", async () => {
  const snapshots = ["A".repeat(6000), "B".repeat(6000), "C".repeat(6000)];
  let i = 0;
  const model = scriptedModel([toolCall("snap", {}), toolCall("snap", {}), toolCall("snap", {}), text("done")]);
  await generateText({
    model,
    prompt: "go",
    tools: { snap: tool({ inputSchema: z.object({}), execute: async () => ({ content: [{ type: "text", text: snapshots[i++] }] }) }) },
    stopWhen: isStepCount(10),
    prepareStep: async ({ messages }) => ({ messages: pruneMessages(messages, { keepLargeResults: 1, largeResultChars: 4000 }) }),
  });
  const last = JSON.stringify(model.doGenerateCalls.at(-1)!.prompt);
  expect(last).toContain("C".repeat(6000));
  expect(last).not.toContain("A".repeat(6000));
  expect(last).not.toContain("B".repeat(6000));
  expect(last.match(/snap result elided/g)).toHaveLength(2);
});
