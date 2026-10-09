import { el, icon, put } from "./dom.ts";

export type Tone = "ok" | "bad" | "warn" | "info" | "neutral";

export const STATUS_TONE: Record<string, Tone> = { succeeded: "ok", running: "info", queued: "info", failed: "bad", cancelled: "neutral", stopped_budget: "warn", skipped: "neutral" };
export const STATUS_LABEL: Record<string, string> = { succeeded: "Complete", running: "Live", queued: "Queued", failed: "Failed", cancelled: "Cancelled", stopped_budget: "Stopped at cap", skipped: "Skipped" };
export const VERDICT_TONE: Record<string, Tone> = { confirmed: "bad", refuted: "ok", inconclusive: "warn", could_not_judge: "neutral", unchecked: "neutral", friction: "info", dismissed: "neutral" };
export const VERDICT_LABEL: Record<string, string> = { confirmed: "Confirmed", refuted: "Refuted", inconclusive: "Inconclusive", could_not_judge: "Could not be judged", unchecked: "Not judged", friction: "Friction", dismissed: "Not a bug" };
export const GROUP_VERDICT: Record<string, string> = { confirmed: "confirmed", refuted: "refuted", inconclusive: "inconclusive", couldNotJudge: "could_not_judge", notJudged: "unchecked", friction: "friction", dismissed: "dismissed" };
const SEVERITY_TONE: Record<string, Tone> = { critical: "bad", high: "bad", medium: "warn", low: "neutral" };

export const label = (text: string) => text.replaceAll("_", " ");
export const money = (usd: number) => `$${usd.toFixed(2)}`;
export const shortDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
export const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : url);

export function pill(text: string, tone: Tone, options: { live?: boolean } = {}): HTMLElement {
  return el("span", { class: `pill tone-${tone}` }, el("i", { class: options.live ? "dot live" : "dot", "aria-hidden": "true" }), text);
}

export const statusPill = (status: string, live = false) => pill(STATUS_LABEL[status] ?? label(status), STATUS_TONE[status] ?? "neutral", { live: live || status === "running" });
export const verdictChip = (verdict: string | null) => (verdict ? chip(VERDICT_LABEL[verdict] ?? label(verdict), VERDICT_TONE[verdict] ?? "neutral") : null);
export const severityChip = (severity: string) => el("span", { class: `chip sev tone-${SEVERITY_TONE[severity] ?? "neutral"}` }, severity);

export function chip(text: string, tone: Tone = "neutral", ...lead: Array<Node | null>): HTMLElement {
  const node = el("span", { class: `chip tone-${tone}` });
  put(node, ...lead, text);
  return node;
}

export function avatar(name: string, size = 28): HTMLElement {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  const initial = [...name.trim()][0]?.toUpperCase() ?? "?";
  const node = el("span", { class: "avatar", "aria-hidden": "true", style: `--h:${hash};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px` }, initial);
  return node;
}

export function person(name: string, size = 24): HTMLElement {
  return el("span", { class: "person" }, avatar(name, size), el("span", {}, name));
}

export function meter(value: number, max: number, tone: Tone, name: string): HTMLElement {
  const percent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return el("span", { class: `meter tone-${tone}`, role: "img", "aria-label": `${name}: ${value} of ${max}` }, el("i", { style: `width:${percent}%` }));
}

export function stack(parts: Array<{ value: number; tone: Tone; label: string }>): HTMLElement {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const bar = el("span", { class: "stack", role: "img", "aria-label": parts.map((p) => `${p.label} ${p.value}`).join(", ") });
  if (total === 0) bar.append(el("i", { class: "tone-neutral", style: "width:100%;opacity:.25" }));
  for (const p of parts) if (p.value > 0) bar.append(el("i", { class: `tone-${p.tone}`, style: `width:${(p.value / total) * 100}%` }));
  return bar;
}

export function tile(title: string, value: string, tone: Tone, ...below: Array<Node | null | false>): HTMLElement {
  return el("div", { class: "tile" }, el("p", { class: "tile-title" }, title), el("p", { class: `tile-value tone-${tone}` }, value), ...below.filter(Boolean) as Node[]);
}

export function button(text: string, options: { icon?: string; kind?: "primary" | "ghost"; onclick?: () => void; attrs?: Record<string, string> } = {}): HTMLButtonElement {
  const node = el("button", { type: "button", class: `btn ${options.kind ?? "ghost"}`, ...options.attrs });
  put(node, options.icon ? icon(options.icon, 15) : null, text);
  if (options.onclick) node.onclick = options.onclick;
  return node;
}

export function goalMark(status: string | null): HTMLElement {
  const [name, tone, text] = status === "reached" ? ["check", "ok", "Reached"] : status === "failed" ? ["x", "bad", "Missed"] : status === "not_attempted" ? ["minus", "warn", "Not attempted"] : ["minus", "neutral", "Not tested"];
  return el("span", { class: `mark tone-${tone}`, role: "img", "aria-label": text, title: text }, icon(name!, 13));
}

export function segmented(options: Array<{ value: string; label: string; count?: number }>, current: string, onPick: (value: string) => void, name: string): HTMLElement {
  return el("div", { class: "segmented", role: "group", "aria-label": name }, ...options.map((o) => {
    const node = el("button", { type: "button", "data-filter": o.value, "aria-pressed": current === o.value }, o.label, o.count !== undefined && el("span", { class: "count" }, String(o.count)));
    node.onclick = () => onPick(o.value);
    return node;
  }));
}

export function empty(text: string, hint?: string): HTMLElement {
  return el("div", { class: "empty" }, el("p", {}, text), hint && el("p", { class: "muted" }, hint));
}
