import type { CiAdapter } from "./types.ts";

export const generic: CiAdapter = {
  name: "generic",
  detect: () => true,
  pullRequest: () => undefined,
  postComment: async () => "skipped",
};
