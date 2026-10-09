import { el, icon, put } from "./dom.ts";
import type { Host, View } from "./host.ts";
import { failureText, payloadOf, type ProjectList } from "./types.ts";
import { button, chip, empty, hostOf, statusPill } from "./ui.ts";

export function projectsView(list: ProjectList, host: Host): View {
  const root = el("div", { class: "view projects" });
  const error = el("div", {});
  if (host.canGoBack()) put(root, el("div", { class: "toolbar" }, button("Back", { icon: "back", onclick: () => host.back() })));
  put(root, el("h1", { class: "title" }, "Projects"), error);
  const state = { opening: false, disposed: false };
  async function open(id: string) {
    if (state.opening) return;
    state.opening = true;
    error.replaceChildren();
    const result = await host.call("list_runs", { project: id, limit: 20 }).catch(() => null);
    state.opening = false;
    if (state.disposed) return;
    const payload = result && !result.isError ? payloadOf(result.structuredContent) : null;
    if (!payload || payload.view !== "runs") { put(error, el("p", { class: "notice", role: "alert" }, icon("alert", 16), el("span", {}, result && result.isError ? failureText(result) : "Could not load the runs of this project."))); return; }
    host.show({ ...payload, args: { project: id } });
  }
  if (list.projects.length === 0) put(root, empty("No projects."));
  else put(root, el("ul", { class: "cards" }, ...list.projects.map((p) => {
    const last = p.lastRun;
    const card = el("button", { type: "button", class: "card project", "data-project": p.id },
      el("span", { class: "project-icon", "aria-hidden": "true" }, icon("folder", 20)),
      el("span", { class: "project-main" }, el("strong", {}, p.name), el("span", { class: "muted small" }, p.site ?? hostOf(p.targetUrl))),
      last ? el("span", { class: "project-last" }, el("span", { class: "muted small" }, "Last run"), el("span", { class: "row" }, el("span", { class: "mono" }, `#${last.number}`), statusPill(last.status), chip(`${last.confirmedDefects} ${last.confirmedDefects === 1 ? "defect" : "defects"}`, last.confirmedDefects > 0 ? "bad" : "ok")))
        : el("span", { class: "muted small" }, "No runs yet"),
      icon("arrow", 15));
    card.onclick = () => void open(p.id);
    return el("li", {}, card);
  })));
  if (list.nextCursor) put(root, el("p", { class: "muted small" }, "More projects exist. Ask the assistant for the next page."));
  return { el: root, dispose() { state.disposed = true; } };
}
