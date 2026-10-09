import { el, icon, put, untrustedBlock, type Untrusted } from "./dom.ts";
import type { Host } from "./host.ts";
import { failureText, type Detail } from "./types.ts";
import { button, chip } from "./ui.ts";

type Loaded = { kind: "screenshot"; src: string; note: string } | { kind: "trail"; blocks: Untrusted[]; next: string | null };

export class EvidenceStore {
  loaded = new Map<string, Loaded>();
  errors = new Map<string, string>();
  loading = new Set<string>();

  constructor(private run: () => number | null, private host: Host, private selected: () => string | null, private changed: () => void) {}

  reset() {
    this.loaded.clear();
    this.errors.clear();
    this.loading.clear();
  }

  async load(ref: string, label: string, before?: string) {
    const run = this.run();
    const key = this.selected();
    const flight = `${run}|${key}|${ref}|${before ?? ""}`;
    if (run === null || key === null || this.loading.has(flight)) return;
    this.loading.add(flight);
    const result = await this.host.call("get_evidence", { run, ref, ...(before ? { before } : {}) }).catch(() => null);
    this.loading.delete(flight);
    if (this.selected() !== key || this.run() !== run) return;
    if (!result || result.isError) {
      this.errors.set(ref, result ? failureText(result) : "Could not load this evidence. Try again.");
      this.changed();
      this.host.announce(`Could not load: ${label}.`);
      return;
    }
    const structured = result.structuredContent as { kind: "screenshot" | "trail"; trail?: Untrusted; nextBefore?: string | null };
    const image = result.content?.find((c) => c.type === "image");
    if (structured.kind === "screenshot" && image?.data && /^image\/(png|jpeg|webp)$/.test(image.mimeType ?? "")) this.loaded.set(ref, { kind: "screenshot", src: `data:${image.mimeType};base64,${image.data}`, note: `${label}. Passwords and other secrets are blacked out.` });
    if (structured.kind === "trail" && structured.trail) {
      const previous = before ? this.loaded.get(ref) : undefined;
      this.loaded.set(ref, { kind: "trail", blocks: [...(previous?.kind === "trail" ? previous.blocks : []), structured.trail], next: structured.nextBefore ?? null });
    }
    this.errors.delete(ref);
    this.changed();
    this.host.announce(`Loaded: ${label}.`);
  }
}

export function findingPanel(d: Detail, store: EvidenceStore, attrs: Record<string, string> = {}): HTMLElement {
  const panel = el("div", { class: "panel", role: "region", "aria-label": `Details of ${d.title.text}`.slice(0, 160), ...attrs });
  const section = (title: string, ...kids: Array<Node | false | null>) => el("section", {}, el("h3", {}, title), ...kids.filter(Boolean) as Node[]);
  put(panel,
    section("What was observed", untrustedBlock(d.observed)),
    section("How to reproduce it", untrustedBlock(d.reproduction)),
    d.quote && section("Quoted from the page", untrustedBlock(d.quote)),
    d.page && section("Page", untrustedBlock(d.page, "p")),
    d.replay && section(d.replay.completed === false ? "Replay (did not finish)" : "Replay", d.replay.observed ? untrustedBlock(d.replay.observed) : el("p", { class: "muted" }, "The replay saw nothing to report.")),
    d.dismissal && section(`Marked not a bug by ${d.dismissal.by}`, untrustedBlock(d.dismissal.reason, "p")),
    d.sameReports.length > 0 && section("Reported the same way", el("ul", { class: "plain" }, ...d.sameReports.map((s) => el("li", {}, s.title.text)))),
  );
  const list = el("ul", { class: "evidence" });
  for (const e of d.evidence) {
    const loaded = store.loaded.get(e.ref);
    const show = button(`${loaded ? "Reload" : "Show"}: ${e.label}`, { icon: e.kind === "screenshot" ? "camera" : "steps", attrs: { "data-ref": e.ref, "data-role": "show" } });
    show.onclick = () => void store.load(e.ref, e.label);
    const item = el("li", {}, show, store.errors.has(e.ref) && el("p", { class: "muted", role: "status" }, store.errors.get(e.ref)));
    if (loaded?.kind === "screenshot") item.append(el("figure", { class: "capture" }, el("img", { src: loaded.src, alt: `Screen capture: ${e.label}` }), el("figcaption", {}, loaded.note)));
    if (loaded?.kind === "trail") {
      item.append(...loaded.blocks.map((b) => untrustedBlock(b)));
      if (loaded.next) {
        const older = button("Older steps", { attrs: { "data-ref": e.ref, "data-role": "older" } });
        older.onclick = () => void store.load(e.ref, e.label, loaded.next!);
        item.append(older);
      }
    }
    list.append(item);
  }
  panel.append(section("Evidence", list));
  return panel;
}

export const evidenceChip = (n: number) => (n > 0 ? chip(`${n}`, "neutral", icon("camera", 12)) : null);
