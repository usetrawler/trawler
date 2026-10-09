import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { compareView } from "./compare.ts";
import { startedView, stoppedView } from "./control.ts";
import { clear, el, put } from "./dom.ts";
import { findingView } from "./finding.ts";
import type { Host, View } from "./host.ts";
import { projectsView } from "./projects.ts";
import { reportView } from "./report.ts";
import { runsView } from "./runs.ts";
import { failureText, payloadOf, type Payload, type Result } from "./types.ts";

const app = new App({ name: "Trawler", version: "2.0.0" }, {}, { autoResize: true });
const root = document.getElementById("app")!;
const status = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });
const note = el("div", { "data-part": "note" });
const stage = el("div", { class: "stage" });
put(root, status, note, stage);

const stack: Array<View & { opener?: Element | null }> = [];
let building = false;
let input: Record<string, unknown> = {};

function build(payload: Payload): View {
  switch (payload.view) {
    case "report": return reportView(payload.data, host);
    case "compare": return compareView(payload.data, host);
    case "finding": return findingView(payload.data, host);
    case "runs": return runsView(payload.data, host, payload.args);
    case "projects": return projectsView(payload.data, host);
    case "started": return startedView(payload.data, host);
    case "stopped": return stoppedView(payload.data, host);
  }
}

function replaceAll() {
  for (const view of stack.splice(0)) view.dispose();
  clear(stage);
}

function show(payload: Payload, push = true) {
  const top = stack.at(-1);
  if (!push) {
    if (top && payload.view === "report" && top.update && top.key === `run:${payload.data.number}` && stack.length === 1) { top.update(payload); return; }
    replaceAll();
  } else top?.setActive?.(false);
  const opener = document.activeElement;
  building = push && !!top;
  let view: View;
  try {
    view = build(payload);
  } catch {
    building = false;
    top?.setActive?.(true);
    clear(note);
    put(note, el("p", { class: "notice", role: "alert" }, "Trawler could not display this result."));
    return;
  } finally {
    building = false;
  }
  if (push && top) top.el.hidden = true;
  stack.push(Object.assign(view, { opener }));
  stage.append(view.el);
  if (push) {
    window.scrollTo(0, 0);
    const heading = view.el.querySelector("h1") as HTMLElement | null;
    if (heading) { heading.tabIndex = -1; heading.focus(); host.announce(heading.textContent ?? ""); }
  }
}

function back() {
  if (stack.length < 2) return;
  const closed = stack.pop()!;
  closed.dispose();
  closed.el.remove();
  const previous = stack.at(-1)!;
  previous.el.hidden = false;
  previous.setActive?.(true);
  window.scrollTo(0, 0);
  const opener = closed.opener as HTMLElement | null | undefined;
  if (opener && opener.isConnected) opener.focus();
  else (previous.el.querySelector("h1") as HTMLElement | null)?.focus();
}

const linkNote = (url: string) => {
  clear(note);
  put(note, el("p", { class: "notice", role: "status" }, `The host did not open the link. It is ${url}`));
};

const host: Host = {
  call: async (name, args) => (await app.callServerTool({ name, arguments: args })) as Result,
  announce: (text) => { status.textContent = text; },
  open: (url) => {
    if (!app.getHostCapabilities()?.openLinks) { linkNote(url); return; }
    void app.openLink({ url }).then((outcome) => { if ((outcome as { isError?: boolean }).isError) linkNote(url); }).catch(() => linkNote(url));
  },
  show: (payload) => show(payload, true),
  canGoBack: () => stack.length > 1 || building,
  back,
};

function theme() {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

app.ontoolresult = (result) => {
  clear(note);
  if (result.isError) { put(note, el("p", { class: "notice", role: "alert" }, failureText(result as Result))); return; }
  const payload = payloadOf(result.structuredContent);
  if (payload?.view === "runs") payload.args = { ...input };
  if (payload) show(payload, false);
};
app.ontoolinput = (params) => { input = { ...(params.arguments ?? {}) }; delete input.limit; delete input.before; };
app.onhostcontextchanged = () => theme();
app.onteardown = async () => { replaceAll(); return {}; };

await app.connect();
theme();
