import type { ModelMessage, ToolResultPart } from "ai";

function size(part: ToolResultPart): number {
  const o = part.output;
  return o.type === "text" || o.type === "error-text" ? o.value.length : JSON.stringify(o).length;
}

function isElided(part: ToolResultPart): boolean {
  return part.output.type === "text" && /^\[.+ result elided: \d+ chars\]$/.test(part.output.value);
}

export function pruneMessages(messages: ModelMessage[], opts: { keepLargeResults: number; largeResultChars: number }): ModelMessage[] {
  const large: Array<[number, number]> = [];
  messages.forEach((m, mi) => {
    if (m.role !== "tool") return;
    m.content.forEach((p, pi) => {
      if (p.type === "tool-result" && !isElided(p) && size(p) > opts.largeResultChars) large.push([mi, pi]);
    });
  });
  const elide = new Set(large.slice(0, Math.max(0, large.length - opts.keepLargeResults)).map(([mi, pi]) => `${mi}:${pi}`));
  if (elide.size === 0) return messages;
  return messages.map((m, mi) => {
    if (m.role !== "tool") return m;
    return {
      ...m,
      content: m.content.map((p, pi) =>
        p.type === "tool-result" && elide.has(`${mi}:${pi}`)
          ? { ...p, output: { type: "text" as const, value: `[${p.toolName} result elided: ${size(p)} chars]` } }
          : p,
      ),
    };
  });
}
