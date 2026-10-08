import { expect, test } from "vitest";
import { RUN_CONTROL_ROLE } from "./access.ts";
import { consentOptions } from "./consent-options.ts";
import { RUN_CONTROL_OFF } from "./settings.ts";

const on = { connectionsAllowed: true, runControlAllowed: true };
const off = { connectionsAllowed: true, runControlAllowed: false };

test("run control is offered only when the client asked for it, the workspace allows it and the role may use it", () => {
  expect(consentOptions(["trawler:read", "trawler:runs:write"], on, "member")).toEqual({ wantsControl: true, controlOffered: true, controlNote: null });
  expect(consentOptions(["trawler:read"], on, "member")).toEqual({ wantsControl: false, controlOffered: false, controlNote: null });
});

test("when run control is asked for but not offered, the reason is the workspace switch first and the role second", () => {
  expect(consentOptions(["trawler:read", "trawler:runs:write"], off, "member")).toEqual({ wantsControl: true, controlOffered: false, controlNote: RUN_CONTROL_OFF });
  expect(consentOptions(["trawler:read", "trawler:runs:write"], on, "viewer")).toEqual({ wantsControl: true, controlOffered: false, controlNote: RUN_CONTROL_ROLE });
  expect(consentOptions(["trawler:read", "trawler:runs:write"], off, "viewer").controlNote).toBe(RUN_CONTROL_OFF);
});
