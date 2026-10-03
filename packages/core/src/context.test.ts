import { generateText, isStepCount, tool, type ModelMessage, type ToolResultPart } from "ai";
import { z } from "zod";
import { expect, test } from "vitest";
import { dropOldReasoning, PICTURE_GONE, pruneMessages, showUnreadPictures } from "./context.ts";
import { scriptedModel, text, toolCall } from "./testing.ts";

function result(id: string, toolName: string, value: string): ModelMessage {
  return { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "text", value } }] };
}

function outputOf(m: ModelMessage | undefined) {
  return (m as { content: Array<{ output: { type: string; value?: unknown } }> }).content[0]!.output;
}

const big = "x".repeat(5000);
const READ: ModelMessage = { role: "assistant", content: "Looked at the results." };
const opts = { keepLargeResults: 1, largeResultChars: 2000 };

test("keeps only the latest large result verbatim", () => {
  const msgs: ModelMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    result("1", "browser_snapshot", big),
    result("2", "browser_snapshot", big),
    result("3", "browser_snapshot", big),
    READ,
  ];
  const values = pruneMessages(msgs, opts).slice(2, 5).map((m) => outputOf(m).value);
  expect(values).toEqual(["[browser_snapshot result elided: 5000 chars; take a new snapshot to see the page again]", "[browser_snapshot result elided: 5000 chars; take a new snapshot to see the page again]", big]);
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
  const out = pruneMessages([err, result("2", "browser_snapshot", big), READ], opts);
  expect(outputOf(out[0])).toEqual({ type: "error-text", value: "[browser_click result elided: 5000 chars; take a new snapshot to see the page again]" });
  const tiny = { keepLargeResults: 1, largeResultChars: 10 };
  const once = pruneMessages([err, result("2", "browser_snapshot", big), READ], tiny);
  expect(pruneMessages(once, tiny)).toEqual(once);
});

test("an elided error-json becomes an error-text marker", () => {
  const err: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "browser_click", output: { type: "error-json", value: { message: big } } }] };
  const out = pruneMessages([err, result("2", "browser_snapshot", big), READ], opts);
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
  const out = pruneMessages([json, content, result("3", "browser_snapshot", big), READ], opts);
  expect(outputOf(out[0]).value).toBe(`[browser_navigate result elided: ${JSON.stringify({ content: [{ type: "text", text: big }] }).length} chars; take a new snapshot to see the page again]`);
  expect(outputOf(out[1]).value).toBe(`[browser_click result elided: ${JSON.stringify([{ type: "text", text: big }]).length} chars; take a new snapshot to see the page again]`);
});

test("keeps the last N when asked for more than one", () => {
  const msgs = [...[1, 2, 3, 4].map((n) => result(String(n), "browser_snapshot", big)), READ];
  const kept = pruneMessages(msgs, { keepLargeResults: 2, largeResultChars: 2000 }).filter((m) => m.role === "tool" && outputOf(m).value === big);
  expect(kept).toHaveLength(2);
});

test("results the model has not read yet are never elided, however many arrived in one turn", () => {
  const turn: ModelMessage = { role: "assistant", content: [1, 2, 3].map((n) => ({ type: "tool-call" as const, toolCallId: String(n), toolName: "browser_snapshot", input: {} })) };
  const older = result("0", "browser_snapshot", big);
  const msgs: ModelMessage[] = [older, READ, turn, result("1", "browser_navigate", big), result("2", "browser_snapshot", big), result("3", "browser_click", big)];
  const out = pruneMessages(msgs, opts);
  expect(outputOf(out[0]).value).toMatch(/elided/);
  expect(out.slice(3).map((m) => outputOf(m).value)).toEqual([big, big, big]);
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

const thinking = (n: number): ModelMessage => ({
  role: "assistant",
  providerOptions: { openrouter: { reasoning_details: [{ type: "reasoning.text", text: `step ${n}` }], annotations: [] }, other: { keep: true } },
  content: [
    { type: "reasoning", text: `thought ${n}`, providerOptions: { openrouter: { reasoning_details: [{ type: "reasoning.text", text: `step ${n}` }] } } },
    { type: "text", text: `said ${n}` },
    { type: "tool-call", toolCallId: `call-${n}`, toolName: "browser_click", input: { target: `e${n}` }, providerOptions: { openrouter: { reasoning_details: [{ type: "reasoning.text", text: `step ${n}` }] } } },
  ],
});

test("reasoning of all but the last steps is dropped, with what the provider would send back, and everything else is kept", () => {
  const msgs: ModelMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];
  for (let n = 1; n <= 4; n++) msgs.push(thinking(n), result(`call-${n}`, "browser_click", "ok"));
  const pruned = dropOldReasoning(msgs, 2);
  const shown = JSON.stringify(pruned);
  for (const n of [1, 2]) {
    expect(shown).not.toContain(`thought ${n}`);
    expect(shown).not.toContain(`"step ${n}"`);
  }
  for (const n of [3, 4]) {
    expect(shown).toContain(`thought ${n}`);
    expect(pruned[2 * n]).toEqual(msgs[2 * n]);
  }
  const first = pruned[2] as Extract<ModelMessage, { role: "assistant" }>;
  expect(first.providerOptions).toEqual({ openrouter: { annotations: [] }, other: { keep: true } });
  expect((first.content as Array<{ type: string }>).map((p) => p.type)).toEqual(["text", "tool-call"]);
  const calls = pruned.flatMap((m) => (m.role === "assistant" && typeof m.content !== "string" ? m.content.filter((p) => p.type === "tool-call").map((p) => (p as { toolCallId: string }).toolCallId) : []));
  const results = pruned.flatMap((m) => (m.role === "tool" ? m.content.map((p) => (p as { toolCallId: string }).toolCallId) : []));
  expect(calls).toEqual(["call-1", "call-2", "call-3", "call-4"]);
  expect(results).toEqual(calls);
  expect(pruned.filter((m) => m.role !== "assistant")).toEqual(msgs.filter((m) => m.role !== "assistant"));
});

test("a conversation with no more steps than kept, or plain text replies, is left alone", () => {
  const msgs: ModelMessage[] = [{ role: "user", content: "go" }, thinking(1), result("call-1", "browser_click", "ok"), thinking(2)];
  expect(dropOldReasoning(msgs, 2)).toBe(msgs);
  const plain: ModelMessage[] = [{ role: "assistant", content: "hello" }, { role: "assistant", content: "again" }, thinking(3)];
  expect(dropOldReasoning(plain, 1).slice(0, 2)).toEqual(plain.slice(0, 2));
});

const PNG = { type: "data" as const, data: "iVBORw0KGgo=" };
function picture(id: string, toolName = "look_at_page"): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName, output: { type: "content", value: [{ type: "text", text: "Here is the page." }, { type: "file", data: PNG, mediaType: "image/png" }] } }],
  };
}
const SEEN: ModelMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "look_at_page", input: {} }] };

test("a picture the model has not read yet reaches it as text in the result and the image in a user message right after", () => {
  const msgs: ModelMessage[] = [{ role: "user", content: "go" }, SEEN, picture("1")];
  const out = showUnreadPictures(msgs);
  expect(out).toHaveLength(4);
  expect(out.slice(0, 2)).toEqual(msgs.slice(0, 2));
  expect(outputOf(out[2])).toEqual({ type: "text", value: "Here is the page." });
  expect(out[3]).toEqual({ role: "user", content: [{ type: "file", data: PNG, mediaType: "image/png" }] });
});

test("a picture the model has read, because it answered after it, is replaced by a note and no image is sent", () => {
  const msgs: ModelMessage[] = [{ role: "user", content: "go" }, SEEN, picture("1"), READ, result("2", "browser_snapshot", "page")];
  const out = showUnreadPictures(msgs);
  expect(out).toHaveLength(msgs.length);
  expect(outputOf(out[2])).toEqual({ type: "text", value: PICTURE_GONE });
  expect(out.some((m) => m.role === "user" && typeof m.content !== "string" && m.content.some((p) => p.type === "file"))).toBe(false);
  expect(out[4]).toBe(msgs[4]);
});

test("messages without a picture are untouched, and the input is not mutated", () => {
  const msgs: ModelMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "go" }, result("1", "browser_snapshot", big), READ];
  const out = showUnreadPictures(msgs);
  expect(out).toEqual(msgs);
  out.forEach((m, i) => expect(m).toBe(msgs[i]));
  const withPicture: ModelMessage[] = [SEEN, picture("1")];
  const copy = structuredClone(withPicture);
  showUnreadPictures(withPicture);
  expect(withPicture).toEqual(copy);
});

test("a tool message holding a picture and another result keeps the other result as it was", () => {
  const both: ModelMessage = { role: "tool", content: [(result("2", "note", "noted") as { content: ToolResultPart[] }).content[0]!, (picture("1") as { content: ToolResultPart[] }).content[0]!] };
  const out = showUnreadPictures([SEEN, both]);
  expect(out).toHaveLength(3);
  const parts = (out[1] as { content: ToolResultPart[] }).content;
  expect(parts[0]).toEqual((both as { content: ToolResultPart[] }).content[0]);
  expect(parts[1]!.output).toEqual({ type: "text", value: "Here is the page." });
  expect(out[2]).toEqual({ role: "user", content: [{ type: "file", data: PNG, mediaType: "image/png" }] });
  const read = showUnreadPictures([SEEN, both, READ]);
  expect(read).toHaveLength(3);
  expect((read[1] as { content: ToolResultPart[] }).content[1]!.output).toEqual({ type: "text", value: PICTURE_GONE });
});

test("a content result with only text, or with a file that is not an image, is left as it is", () => {
  const pdf: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "browser_navigate", output: { type: "content", value: [{ type: "file", data: PNG, mediaType: "application/pdf" }] } }] };
  const textual: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "browser_click", output: { type: "content", value: [{ type: "text", text: "clicked" }] } }] };
  const out = showUnreadPictures([SEEN, pdf, textual]);
  expect(out[1]).toBe(pdf);
  expect(out[2]).toBe(textual);
});

test("in a real agent loop the model gets the picture as an image on the turn after it is taken", async () => {
  const pictureTool = tool({
    inputSchema: z.object({}),
    execute: async () => "pic",
    toModelOutput: () => ({ type: "content", value: [{ type: "text", text: "shown" }, { type: "file", data: PNG, mediaType: "image/png" }] }),
  });
  const model = scriptedModel([toolCall("look", {}), text("done")]);
  await generateText({
    model, prompt: "go", tools: { look: pictureTool }, stopWhen: isStepCount(10),
    prepareStep: async ({ messages }) => ({ messages: showUnreadPictures(messages) }),
  });
  const prompt = model.doGenerateCalls[1]!.prompt;
  expect(prompt.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  expect(prompt[2]).toMatchObject({ content: [{ output: { type: "text", value: "shown" } }] });
  expect(prompt[3]).toMatchObject({ content: [{ type: "file", mediaType: "image/png", data: PNG }] });
});

test("a picture already moved into a user message, once read, is replaced by a note; an unread one is kept", () => {
  const moved = showUnreadPictures([{ role: "user", content: "go" }, SEEN, picture("1")]);
  const later = showUnreadPictures([...moved, READ, result("2", "browser_snapshot", "page")]);
  expect(later[3]).toEqual({ role: "user", content: [{ type: "text", text: PICTURE_GONE }] });
  expect(later.some((m) => m.role === "user" && typeof m.content !== "string" && m.content.some((p) => p.type === "file"))).toBe(false);
  expect(showUnreadPictures(moved)).toEqual(moved);
});
