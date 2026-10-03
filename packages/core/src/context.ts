import type { AssistantModelMessage, FilePart, ModelMessage, ToolResultPart } from "ai";

export const PICTURE_GONE = "[the picture of the page is no longer shown; look at the page again to see it as it is now]";

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

function picturesIn(output: ToolResultPart["output"]): FilePart[] {
  if (output.type !== "content") return [];
  return output.value.flatMap((p) => (p.type === "file" && p.mediaType.startsWith("image") ? [{ type: "file" as const, data: p.data, mediaType: p.mediaType }] : []));
}

function textIn(output: ToolResultPart["output"]): string {
  return output.type === "content" ? output.value.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") : "";
}

export function showUnreadPictures(messages: ModelMessage[]): ModelMessage[] {
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  return messages.flatMap((m, mi): ModelMessage[] => {
    if (m.role !== "tool" || !m.content.some((p) => p.type === "tool-result" && picturesIn(p.output).length > 0)) return [m];
    const unread = mi > lastAssistant;
    const shown: FilePart[] = [];
    const content = m.content.map((p) => {
      if (p.type !== "tool-result") return p;
      const pictures = picturesIn(p.output);
      if (pictures.length === 0) return p;
      if (unread) shown.push(...pictures);
      return { ...p, output: { type: "text" as const, value: unread ? textIn(p.output) : PICTURE_GONE } };
    });
    return shown.length > 0 ? [{ ...m, content }, { role: "user", content: shown }] : [{ ...m, content }];
  });
}

type ProviderOptions = AssistantModelMessage["providerOptions"];

function withoutReasoningDetails(options: ProviderOptions): ProviderOptions {
  const openrouter = options?.openrouter;
  if (!openrouter || !("reasoning_details" in openrouter)) return options;
  const { reasoning_details: _dropped, ...rest } = openrouter;
  return { ...options, openrouter: rest };
}

export function dropOldReasoning(messages: ModelMessage[], keepSteps: number): ModelMessage[] {
  const assistants = messages.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  const old = new Set(assistants.slice(0, Math.max(0, assistants.length - keepSteps)));
  if (old.size === 0) return messages;
  return messages.map((m, i) => {
    if (m.role !== "assistant" || !old.has(i)) return m;
    const providerOptions = withoutReasoningDetails(m.providerOptions);
    if (typeof m.content === "string") return { ...m, providerOptions };
    return {
      ...m,
      providerOptions,
      content: m.content.filter((p) => p.type !== "reasoning").map((p) => (p.type === "tool-call" ? { ...p, providerOptions: withoutReasoningDetails(p.providerOptions) } : p)),
    };
  });
}
