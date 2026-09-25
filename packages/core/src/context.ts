import type { ModelMessage, ToolResultPart } from "ai";

function size(part: ToolResultPart): number {
  const o = part.output;
  if (o.type === "text" || o.type === "error-text") return o.value.length;
  return JSON.stringify("value" in o ? o.value : o).length;
}

function isElided(part: ToolResultPart): boolean {
  const o = part.output;
  return (o.type === "text" || o.type === "error-text") && /^\[.+ result elided: \d+ chars[^\]]*\]$/.test(o.value);
}

export function pruneMessages(messages: ModelMessage[], opts: { keepLargeResults: number; largeResultChars: number }): ModelMessage[] {
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  const read: Array<[number, number]> = [];
  let unread = 0;
  messages.forEach((m, mi) => {
    if (m.role !== "tool") return;
    m.content.forEach((p, pi) => {
      if (p.type !== "tool-result" || isElided(p) || size(p) <= opts.largeResultChars) return;
      if (mi > lastAssistant) unread++;
      else read.push([mi, pi]);
    });
  });
  const keepRead = Math.max(0, opts.keepLargeResults - unread);
  const elide = new Set(read.slice(0, Math.max(0, read.length - keepRead)).map(([mi, pi]) => `${mi}:${pi}`));
  if (elide.size === 0) return messages;
  return messages.map((m, mi) => {
    if (m.role !== "tool") return m;
    return {
      ...m,
      content: m.content.map((p, pi) =>
        p.type === "tool-result" && elide.has(`${mi}:${pi}`)
          ? { ...p, output: { type: p.output.type.startsWith("error") ? ("error-text" as const) : ("text" as const), value: `[${p.toolName} result elided: ${size(p)} chars; take a new snapshot to see the page again]` } }
          : p,
      ),
    };
  });
}
