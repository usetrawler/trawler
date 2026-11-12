import type { Trail, TrailEntry, TrailTurn } from "../../../runs/trail.ts";


export const TOOL_LABEL: Record<string, string> = {
  browser_navigate: "Opened a page", browser_navigate_back: "Went back", browser_snapshot: "Read the page", browser_click: "Clicked",
  browser_type: "Typed", browser_hover: "Hovered", browser_select_option: "Chose an option", browser_press_key: "Pressed a key",
  browser_wait_for: "Waited", browser_handle_dialog: "Answered a dialog", browser_file_upload: "Closed a file picker",
  sign_in: "Signed in", type_own_password: "Typed their password", look_at_page: "Looked at the page", finish: "Finished",
};
const OWN_ENTRY = new Set(["note", "submit_finding", "goal_status"]);

export const trailAnchor = (personId: string) => `trail-${encodeURIComponent(personId)}`;

export function mergeNewest(had: Trail | null, got: Trail): Trail {
  if (!had || got.olderThan === null || had.entries.length === 0) return got;
  const oldestGot = got.entries[0]?.id ?? got.olderThan;
  if (had.entries.at(-1)!.id < oldestGot) return got;
  return { turns: got.turns, entries: [...had.entries.filter((e) => e.id < oldestGot), ...got.entries], olderThan: had.olderThan };
}

export function mergeEarlier(had: Trail | null, got: Trail, before: number): Trail | null {
  if (!had || had.olderThan !== before) return had;
  return { turns: had.turns, entries: [...got.entries.filter((e) => e.id < before), ...had.entries], olderThan: got.olderThan };
}

export function turnEnd(t: TrailTurn): string {
  if (t.status === "failed") return `Could not finish: ${t.error ?? "no reason was recorded"}`;
  if (t.status === "queued") return "Waiting for this turn.";
  if (t.status === "leased") return "Working on it now.";
  if (t.status === "cancelled" && t.entries === 0) return t.error?.startsWith("not started: ") ? `Did not start: ${t.error.slice("not started: ".length)}` : "Did not start: the run stopped first.";
  if (t.status === "cancelled") return "Stopped before the end of this turn.";
  if (t.stoppedBy === "max_steps") return "Used all the steps this turn had.";
  if (t.stoppedBy === "budget") return "Stopped: the run's cap ran out or the run was stopped.";
  return "Finished this turn.";
}

export const shownEntry = (e: TrailEntry) => !(e.kind === "step" && e.tool && OWN_ENTRY.has(e.tool));
