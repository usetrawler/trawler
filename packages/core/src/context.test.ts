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

test("small results and non-tool messages are untouched while older results are elided", () => {
  const assistant: ModelMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId: "2", toolName: "note", input: {} }] };
  const msgs: ModelMessage[] = [
    { role: "system", content: "sys" },
    result("0", "browser_snapshot", big),
    { role: "user", content: big },
    assistant,
    result("1", "note", "ok"),
    result("2", "browser_click", big),
  ];
  const out = pruneMessages(msgs, opts);
  expect(outputOf(out[1]).value).toMatch(/elided/);
  expect(out[0]).toEqual(msgs[0]);
  expect(out[2]).toEqual(msgs[2]);
  expect(out[3]).toEqual(assistant);
  expect(out[4]).toEqual(msgs[4]);
  expect(outputOf(out[5]).value).toBe(big);
  expect(out).toHaveLength(msgs.length);
});

test("an elided error stays an error", () => {
  const err: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "browser_click", output: { type: "error-text", value: big } }] };
  const out = pruneMessages([err, result("2", "browser_snapshot", big)], opts);
  expect(outputOf(out[0])).toEqual({ type: "error-text", value: "[browser_click result elided: 5000 chars]" });
  const tiny = { keepLargeResults: 1, largeResultChars: 10 };
  const once = pruneMessages([err, result("2", "browser_snapshot", big)], tiny);
  expect(pruneMessages(once, tiny)).toEqual(once);
});

test("an elided error-json becomes an error-text marker", () => {
  const err: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "browser_click", output: { type: "error-json", value: { message: big } } }] };
  const out = pruneMessages([err, result("2", "browser_snapshot", big)], opts);
  expect(outputOf(out[0]).type).toBe("error-text");
});

test("is idempotent and does not mutate its input", () => {
  const msgs: ModelMessage[] = [result("1", "browser_snapshot", big), result("2", "browser_snapshot", big)];
  const copy = structuredClone(msgs);
  const once = pruneMessages(msgs, opts);
  expect(pruneMessages(once, opts)).toEqual(once);
  expect(msgs).toEqual(copy);
});

test("stays idempotent when the threshold is below the length of an elision marker", () => {
  const msgs: ModelMessage[] = [result("1", "browser_snapshot", big), result("2", "browser_snapshot", big)];
  const tiny = { keepLargeResults: 1, largeResultChars: 10 };
  const once = pruneMessages(msgs, tiny);
  expect(pruneMessages(once, tiny)).toEqual(once);
  expect(outputOf(once[1]).value).toBe(big);
});

test("measures json and content outputs by their serialized size", () => {
  const json: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "browser_navigate", output: { type: "json", value: { content: [{ type: "text", text: big }] } } }] };
  const content: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "browser_click", output: { type: "content", value: [{ type: "text", text: big }] } }] };
  const out = pruneMessages([json, content, result("3", "browser_snapshot", big)], opts);
  expect(outputOf(out[0]).value).toBe(`[browser_navigate result elided: ${JSON.stringify({ content: [{ type: "text", text: big }] }).length} chars]`);
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
  const prompt = model.doGenerateCalls.at(-1)!.prompt;
  const callIds = prompt.flatMap((m) => (m.role === "assistant" ? m.content.filter((p) => p.type === "tool-call").map((p) => p.toolCallId) : []));
  const resultIds = prompt.flatMap((m) => (m.role === "tool" ? m.content.filter((p) => p.type === "tool-result").map((p) => p.toolCallId) : []));
  expect(callIds).toEqual(["call-1", "call-2", "call-3"]);
  expect(resultIds).toEqual(callIds);
});
