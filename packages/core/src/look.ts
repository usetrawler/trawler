import { tool } from "ai";
import { z } from "zod";
import type { Screenshot } from "./browser.ts";

export const LOOK_TOOL = "look_at_page";
export const MAX_LOOKS = 10;
export const PICTURE_SHOWN = "Here is the page as it looks now; the picture follows. You see it on this turn only, so note anything you need from it.";

export function lookTool(opts: { screenshot: () => Promise<Screenshot | null>; maxLooks?: number }) {
  const maxLooks = opts.maxLooks ?? MAX_LOOKS;
  let looks = 0;
  return tool({
    description: "See the page as a picture, the way a person sees it: its pictures, layout and colours, and anything covered, cut off or out of place. browser_snapshot gives the page's text and refs, not how it looks.",
    inputSchema: z.object({}),
    execute: async (): Promise<{ picture: string; mediaType: Screenshot["contentType"] } | string> => {
      if (looks >= maxLooks) return `rejected: you have already looked at the page ${maxLooks} times in this session; carry on with browser_snapshot`;
      const shot = await opts.screenshot().catch(() => null);
      if (!shot) return "failed: the page could not be pictured just now, for example while a dialog is open or a password could show; carry on with browser_snapshot";
      looks++;
      return { picture: Buffer.from(shot.bytes).toString("base64"), mediaType: shot.contentType };
    },
    toModelOutput: ({ output }) =>
      typeof output === "string"
        ? { type: "text", value: output }
        : { type: "content", value: [{ type: "text", text: PICTURE_SHOWN }, { type: "file", data: { type: "data", data: output.picture }, mediaType: output.mediaType }] },
  });
}
