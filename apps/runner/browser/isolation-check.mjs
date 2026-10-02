import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const server = createServer((req, res) => {
  if (req.url === "/export.csv") {
    res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=export.csv" });
    return res.end("name,total\nfern,18\n");
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<title>check</title><label>Name <input></label><button>Save</button><a href=/export.csv>Export CSV</a>");
});
await new Promise((resolve) => server.listen(8149, "127.0.0.1", resolve));
const browser = await openBrowser({ allowedOrigins: ["http://127.0.0.1:8149"], outputDir: "/tmp/isolation-check", scrubber: new SecretScrubber(), onBlocked: () => {}, executablePath: process.env.TRAWLER_BROWSER_LAUNCHER, actionGapMs: 0 });
await browser.tools.browser_navigate.execute({ url: "http://127.0.0.1:8149/" }, ctx);
check(JSON.stringify(await browser.tools.browser_snapshot.execute({}, ctx)).includes("Save"), "the page is read through the launched browser");
check(Boolean(await browser.screenshot()), "a screenshot is taken");
const second = await openBrowser({ allowedOrigins: ["http://127.0.0.1:8149"], outputDir: "/tmp/isolation-check-second", scrubber: new SecretScrubber(), onBlocked: () => {}, executablePath: process.env.TRAWLER_BROWSER_LAUNCHER, actionGapMs: 0 });
await second.tools.browser_navigate.execute({ url: "http://127.0.0.1:8149/" }, ctx);
check(JSON.stringify(await browser.tools.browser_snapshot.execute({}, ctx)).includes("Save"), "the first browser still works after a second one opens");
const chromes = processes().filter((p) => p.cmd.includes("chrome-headless-shell"));
check(chromes.length > 0 && chromes.every((p) => p.uid === browserUid), `every Chromium process runs as browser (${chromes.length} processes)`);
writeFileSync("/tmp/isolation-check.pids", chromes.map((p) => p.pid).join("\n"));
for (let i = 0; i < 100 && !existsSync("/tmp/isolation-check.go"); i++) await new Promise((resolve) => setTimeout(resolve, 100));
await second.close();
await browser.close();
for (let i = 0; i < 50 && processes().some((p) => p.uid === browserUid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
check(processes().every((p) => p.uid !== browserUid), "no browser process is left within 5 s of close");
const downloadsPath = mkdtempSync(join(process.env.TRAWLER_BROWSER_DOWNLOADS, "job-"));
chmodSync(downloadsPath, 0o2770);
const downloading = await openBrowser({ allowedOrigins: ["http://127.0.0.1:8149"], outputDir: "/tmp/isolation-check-downloads", scrubber: new SecretScrubber(), onBlocked: () => {}, executablePath: process.env.TRAWLER_BROWSER_LAUNCHER, downloadsPath, actionGapMs: 0 });
await downloading.tools.browser_navigate.execute({ url: "http://127.0.0.1:8149/" }, ctx);
const ref = JSON.stringify(await downloading.tools.browser_snapshot.execute({}, ctx)).match(/link \\"Export CSV\\" \[ref=(e\d+)\]/)?.[1];
const clicked = JSON.stringify(await downloading.tools.browser_click.execute({ element: "Export CSV", target: ref }, ctx));
console.log(`     click result: ${clicked.slice(0, 400)}`);
check(Boolean(ref) && /Downloaded file export\.csv/.test(clicked) && !/"isError":true|canceled|denied/i.test(clicked), "a download the agent starts through the launcher completes, as it does locally");
await downloading.close();
server.close();
process.exit(failures.length ? 1 : 0);
