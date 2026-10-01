import { createServer } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { openBrowser } from "/app/packages/core/src/browser.ts";
import { SecretScrubber } from "/app/packages/core/src/secrets.ts";

const browserUid = Number(process.argv[2]);
const failures = [];
const check = (ok, what) => (ok ? console.log(`ok   ${what}`) : (failures.push(what), console.log(`FAIL ${what}`)));
const ctx = { toolCallId: "check", messages: [], context: {} };
const processes = () => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).flatMap((pid) => {
  try {
    return [{ pid, uid: statSync(`/proc/${pid}`).uid, cmd: readFileSync(`/proc/${pid}/cmdline`, "utf8") }];
  } catch {
    return [];
  }
});

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<title>check</title><label>Name <input></label><button>Save</button>");
});
await new Promise((resolve) => server.listen(8149, "127.0.0.1", resolve));
const browser = await openBrowser({ allowedOrigins: ["http://127.0.0.1:8149"], outputDir: "/tmp/isolation-check", scrubber: new SecretScrubber(), onBlocked: () => {}, executablePath: process.env.TRAWLER_BROWSER_LAUNCHER, actionGapMs: 0 });
await browser.tools.browser_navigate.execute({ url: "http://127.0.0.1:8149/" }, ctx);
check(JSON.stringify(await browser.tools.browser_snapshot.execute({}, ctx)).includes("Save"), "the page is read through the launched browser");
check(Boolean(await browser.screenshot()), "a screenshot is taken");
const chromes = processes().filter((p) => p.cmd.includes("chrome-headless-shell"));
check(chromes.length > 0 && chromes.every((p) => p.uid === browserUid), `every Chromium process runs as browser (${chromes.length} processes)`);
await browser.close();
check(processes().every((p) => p.uid !== browserUid), "no browser process is left after close");
server.close();
process.exit(failures.length ? 1 : 0);
