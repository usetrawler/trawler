const STYLE = `
:root { color-scheme: light dark; --bg: var(--color-background-primary, Canvas); --fg: var(--color-text-primary, CanvasText); --muted: var(--color-text-secondary, color-mix(in srgb, CanvasText 62%, Canvas)); --line: var(--color-border-primary, color-mix(in srgb, CanvasText 22%, Canvas)); --panel: var(--color-background-secondary, color-mix(in srgb, CanvasText 5%, Canvas)); --accent: var(--color-text-info, #0b5fff); --font: var(--font-sans, system-ui, sans-serif); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--font); }
#app { max-width: 960px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
h1 { font-size: 22px; line-height: 1.2; margin: 4px 0 8px; overflow-wrap: anywhere; }
h2 { font-size: 17px; margin: 8px 0; overflow-wrap: anywhere; }
h3 { font-size: 14px; margin: 14px 0 6px; }
p { margin: 4px 0; overflow-wrap: anywhere; }
a { color: var(--accent); }
ul { margin: 4px 0; padding-left: 20px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.muted { color: var(--muted); }
.eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; color: var(--muted); margin: 0; }
.badge { border: 1px solid var(--line); padding: 1px 6px; border-radius: 3px; }
.status-succeeded { border-color: #1a7f37; } .status-failed, .status-cancelled { border-color: #c62828; } .status-running, .status-queued { border-color: var(--accent); }
.notice { border: 1px solid #c62828; padding: 8px 10px; margin: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin: 0; }
.summary dt { color: var(--muted); font-size: 12px; } .summary dd { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
.summary > * { min-width: 0; }
button, select { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 8px 12px; min-height: 44px; cursor: pointer; text-align: left; }
button[aria-pressed="true"], button[aria-expanded="true"] { border-color: var(--fg); font-weight: 600; }
button:focus-visible, select:focus-visible, summary:focus-visible, a:focus-visible, h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.filters { display: flex; flex-wrap: wrap; gap: 6px; }
.findings { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.findings button { width: 100%; overflow-wrap: anywhere; }
.sev { text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; border: 1px solid var(--line); padding: 0 4px; }
.sev-high, .sev-critical { border-color: #c62828; }
.title { font-weight: 600; }
.field { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.untrusted { margin: 6px 0; padding: 8px 10px; border-left: 3px solid var(--line); background: var(--panel); }
.untrusted figcaption { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.untrusted pre, .untrusted p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.from-product { font-style: italic; overflow-wrap: anywhere; }
.detail, .compare { border: 1px solid var(--line); padding: 8px 14px 12px; }
.evidence { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.capture { margin: 6px 0; } .capture img { max-width: 100%; height: auto; border: 1px solid var(--line); display: block; }
details > summary { cursor: pointer; padding: 6px 0; }
@media (max-width: 480px) { #app { padding: 10px; } h1 { font-size: 19px; } }
`;

export function runReportHtml(script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trawler run report</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app" aria-live="off"></div>
<noscript>This report needs scripts. The same results are in the text of the tool result.</noscript>
<script type="module">${script.replaceAll("</script", "<\\/script")}</script>
</body>
</html>
`;
}
