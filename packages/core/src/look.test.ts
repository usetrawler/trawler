import { describe, expect, test } from "vitest";
import { LOOK_TOOL, lookTool, MAX_LOOKS, PICTURE_SHOWN } from "./look.ts";
import type { Screenshot } from "./browser.ts";

const ctx = { toolCallId: "t", messages: [], context: {} };
const shot: Screenshot = { bytes: new Uint8Array([137, 80, 78, 71]), contentType: "image/png" };

async function look(t: ReturnType<typeof lookTool>) {
  const output = await t.execute!({}, ctx);
  return { output, model: await t.toModelOutput!({ toolCallId: "t", input: {}, output } as never) };
}

describe("look_at_page", () => {
  test("a picture goes to the model as a line of text and the image itself, base64 of the bytes, with its media type", async () => {
    const { model } = await look(lookTool({ screenshot: async () => shot }));
    expect(model).toEqual({
      type: "content",
      value: [{ type: "text", text: PICTURE_SHOWN }, { type: "file", data: { type: "data", data: Buffer.from(shot.bytes).toString("base64") }, mediaType: "image/png" }],
    });
    expect(LOOK_TOOL).toBe("look_at_page");
  });

  test("a page that cannot be pictured, because there is no screenshot or taking one throws, says so in text and does not count toward the cap", async () => {
    let next: "none" | "throws" | "picture" = "none";
    const t = lookTool({
      maxLooks: 1,
      screenshot: async () => {
        if (next === "throws") throw new Error("the browser is gone");
        return next === "none" ? null : shot;
      },
    });
    expect((await look(t)).model).toEqual({ type: "text", value: expect.stringMatching(/^failed: the page could not be pictured just now/) });
    next = "throws";
    expect((await look(t)).model).toEqual({ type: "text", value: expect.stringMatching(/^failed: the page could not be pictured just now/) });
    next = "picture";
    expect((await look(t)).model).toMatchObject({ type: "content" });
  });

  test("after the cap of successful looks the next is rejected without taking a screenshot, and the cap defaults to ten", async () => {
    let taken = 0;
    const t = lookTool({ maxLooks: 2, screenshot: async () => (taken++, shot) });
    await look(t);
    await look(t);
    expect((await look(t)).model).toEqual({ type: "text", value: "rejected: you have already looked at the page 2 times in this session; carry on with browser_snapshot" });
    expect(taken).toBe(2);
    expect(MAX_LOOKS).toBe(10);
    const dflt = lookTool({ screenshot: async () => shot });
    for (let i = 0; i < MAX_LOOKS; i++) expect((await look(dflt)).model).toMatchObject({ type: "content" });
    expect((await look(dflt)).model).toMatchObject({ type: "text", value: expect.stringMatching(/^rejected: .* 10 times/) });
  });
});
