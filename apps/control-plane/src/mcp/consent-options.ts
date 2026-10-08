import { canControlRuns, RUN_CONTROL_ROLE } from "./access.ts";
import { RUN_CONTROL_OFF, type McpSettings } from "./settings.ts";

export interface ConsentOptions {
  wantsControl: boolean;
  controlOffered: boolean;
  controlNote: string | null;
}

export function consentOptions(requestedScopes: string[], settings: McpSettings, role: string): ConsentOptions {
  const wantsControl = requestedScopes.includes("trawler:runs:write");
  const controlOffered = wantsControl && settings.runControlAllowed && canControlRuns(role);
  const controlNote = !wantsControl || controlOffered ? null : !settings.runControlAllowed ? RUN_CONTROL_OFF : RUN_CONTROL_ROLE;
  return { wantsControl, controlOffered, controlNote };
}
