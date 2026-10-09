const STYLE = `
:root { color-scheme: light dark; --bg: var(--color-background-primary, #faf8f4); --fg: var(--color-text-primary, #17191c); --muted: var(--color-text-secondary, color-mix(in srgb, var(--fg) 62%, var(--bg)));
  --card: color-mix(in srgb, var(--fg) 4%, var(--bg)); --line: color-mix(in srgb, var(--fg) 14%, transparent); --soft: color-mix(in srgb, var(--fg) 9%, transparent);
  --ok: #2e7d4f; --bad: #c0392b; --warn: #a86a00; --info: #2563c9; --neutral: var(--muted); --action: #ff6b3d; --font: var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --ok: #6fcf97; --bad: #ff8a78; --warn: #f2c14e; --info: #8ab4f8; --action: #ff7045; } }
:root[data-theme="dark"] { --ok: #6fcf97; --bad: #ff8a78; --warn: #f2c14e; --info: #8ab4f8; --action: #ff7045; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
.stage { max-width: 900px; margin: 0 auto; padding: 16px; }
.view > * + * { margin-top: 12px; }
h1 { font-size: 24px; line-height: 1.2; letter-spacing: -0.02em; margin: 2px 0 0; overflow-wrap: anywhere; }
h1.title { font-size: 20px; }
h2 { font-size: 15px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; overflow-wrap: anywhere; }
h3 { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 16px 0 6px; font-weight: 600; }
p { margin: 4px 0; overflow-wrap: anywhere; }
ul { margin: 0; padding: 0; list-style: none; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.muted { color: var(--muted); } .small { font-size: 12px; } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
:focus-visible { outline: 2px solid var(--action); outline-offset: 2px; border-radius: 6px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; box-shadow: 0 1px 0 color-mix(in srgb, var(--fg) 4%, transparent); }
.hero { padding: 20px 22px; position: relative; overflow: hidden; }
.hero::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: linear-gradient(90deg, var(--action), transparent 70%); opacity: 0.9; }
.hero-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.eyebrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 6px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.eyebrow .mono { color: var(--fg); letter-spacing: 0.04em; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 14px 0 0; align-items: center; }
.toolbar { display: flex; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--t, var(--neutral)); background: color-mix(in srgb, var(--t, var(--neutral)) 14%, transparent); border: 1px solid color-mix(in srgb, var(--t, var(--neutral)) 32%, transparent); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; display: inline-block; }
.dot.live { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 55%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
@media (prefers-reduced-motion: reduce) { .dot.live { animation: none; } * { transition: none !important; } }
.tone-ok { --t: var(--ok); } .tone-bad { --t: var(--bad); } .tone-warn { --t: var(--warn); } .tone-info { --t: var(--info); } .tone-neutral { --t: var(--neutral); }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 7px; font-size: 12px; line-height: 1.5; color: var(--t, var(--fg)); background: color-mix(in srgb, var(--t, var(--fg)) 10%, transparent); border: 1px solid color-mix(in srgb, var(--t, var(--fg)) 22%, transparent); overflow-wrap: anywhere; }
.chip.tone-neutral { color: var(--fg); }
.chip.sev { text-transform: uppercase; letter-spacing: 0.06em; font-size: 10.5px; font-weight: 700; }
.avatar { display: inline-grid; place-items: center; border-radius: 50%; font-weight: 700; color: #fff; background: hsl(var(--h) 48% 42%); flex: none; }
.person { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.block .tile { background: transparent; }
.tile-title { margin: 0; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.tile-value { margin: 0; font-size: 32px; line-height: 1; font-weight: 700; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; color: var(--t, var(--fg)); }
.tile-value.tone-neutral { color: var(--fg); }
.tile-sub { margin: 0; font-size: 12px; color: var(--muted); }
.meter, .stack { display: flex; height: 6px; border-radius: 4px; background: var(--soft); overflow: hidden; gap: 2px; width: 100%; }
.meter i, .stack i { display: block; height: 100%; background: var(--t); border-radius: 4px; }
.segmented { display: flex; flex-wrap: wrap; gap: 6px; }
.segmented button { display: inline-flex; align-items: center; gap: 7px; padding: 7px 13px; min-height: 36px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--fg); font: inherit; font-weight: 500; cursor: pointer; }
.segmented button:hover { background: var(--soft); }
.segmented button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); font-weight: 600; }
.count { font-size: 11px; opacity: 0.7; font-variant-numeric: tabular-nums; }
.btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px; min-height: 38px; border-radius: 10px; border: 1px solid var(--line); background: transparent; color: var(--fg); font: inherit; font-weight: 500; cursor: pointer; text-align: left; }
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--action); border-color: var(--action); color: #1d0f08; font-weight: 600; }
.btn.primary:hover { filter: brightness(1.06); }
.notice { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0; padding: 10px 14px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--bad) 30%, transparent); background: color-mix(in srgb, var(--bad) 8%, transparent); }
.callout { display: flex; gap: 12px; padding: 12px 16px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--t) 28%, transparent); background: color-mix(in srgb, var(--t) 8%, transparent); }
.callout svg { color: var(--t); flex: none; margin-top: 3px; }
.callout summary { cursor: pointer; margin-top: 4px; color: var(--muted); }
.field { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border: 1px dashed var(--line); border-radius: 12px; min-width: 0; }
.field span { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); }
select { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; min-height: 36px; max-width: 100%; flex: 1 1 200px; min-width: 0; }
.fold { padding: 0; }
.fold > summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 18px; cursor: pointer; font-weight: 600; list-style: none; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary svg { margin-left: auto; transition: transform 0.15s; }
.fold[open] > summary svg { transform: rotate(180deg); }
.fold > :not(summary) { padding: 0 18px 16px; }
.people-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.person-card { border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
.person-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.person-head p { margin: 0; }
.goals li { display: flex; gap: 8px; padding: 4px 0; align-items: flex-start; }
.goal-text { min-width: 0; }
.mark { flex: none; width: 18px; height: 18px; border-radius: 50%; display: inline-grid; place-items: center; color: var(--t); background: color-mix(in srgb, var(--t) 16%, transparent); margin-top: 1px; }
.findings { display: flex; flex-direction: column; gap: 8px; }
.finding { padding: 0; overflow: hidden; }
.finding.open { border-color: color-mix(in srgb, var(--fg) 30%, transparent); }
.finding-head { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 16px 12px 0; background: transparent; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; min-height: 56px; }
.finding-head:hover { background: var(--soft); }
.finding-head > svg { flex: none; color: var(--muted); transition: transform 0.15s; }
.finding.open .finding-head > svg { transform: rotate(180deg); }
.rail { align-self: stretch; width: 4px; flex: none; background: var(--t); border-radius: 0 3px 3px 0; opacity: 0.9; }
.finding-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.finding-title { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.finding-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.detail-title { font-size: 18px; margin: 4px 18px 0; letter-spacing: -0.01em; }
.panel { padding: 0 18px 18px; }
.panel section + section { margin-top: 2px; }
.untrusted { margin: 6px 0; padding: 10px 12px; border-left: 3px solid color-mix(in srgb, var(--warn) 60%, transparent); background: var(--soft); border-radius: 0 8px 8px 0; }
.untrusted figcaption { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
.untrusted pre, .untrusted p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.from-product { font-style: italic; overflow-wrap: anywhere; }
.evidence { display: flex; flex-direction: column; gap: 10px; }
.capture { margin: 8px 0 0; } .capture img { max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 10px; display: block; } .capture figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; }
.plain { list-style: disc; padding-left: 20px; } .plain li { margin: 3px 0; }
.empty { border: 1px dashed var(--line); border-radius: 14px; padding: 28px 18px; text-align: center; color: var(--muted); }
.versus { display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: stretch; }
.versus-arrow { display: grid; place-items: center; color: var(--muted); }
.run-card .run-headline { font-weight: 600; font-size: 15px; margin-top: 4px; }
.block h2 .muted { font-weight: 400; font-size: 12px; }
.diff li { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; padding: 10px 0; border-top: 1px solid var(--line); }
.diff li:first-child { border-top: 0; padding-top: 2px; }
.diff-main { display: flex; flex-direction: column; min-width: 0; flex: 1 1 260px; gap: 2px; }
.diff-change { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--muted); }
.caveats { color: var(--muted); }
.run-rows { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.run-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; width: 100%; text-align: left; color: inherit; font: inherit; cursor: pointer; padding: 12px 16px; }
.run-row:hover { border-color: color-mix(in srgb, var(--fg) 30%, transparent); }
.run-what { display: flex; flex-direction: column; flex: 1 1 160px; min-width: 0; }
.run-goals { display: flex; flex-direction: column; gap: 4px; flex: 0 0 120px; }
.run-row > svg { color: var(--muted); margin-left: auto; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
.project { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; width: 100%; height: 100%; text-align: left; color: inherit; font: inherit; cursor: pointer; }
.project:hover { border-color: color-mix(in srgb, var(--fg) 30%, transparent); }
.project-icon { width: 36px; height: 36px; display: grid; place-items: center; border-radius: 10px; background: var(--soft); }
.project-main { display: flex; flex-direction: column; } .project-last { display: flex; flex-direction: column; gap: 4px; }
.project > svg { align-self: flex-end; color: var(--muted); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hero .btn { margin-top: 14px; }
.hero-top .btn { margin-top: 0; }
.panel:focus-visible { outline-offset: -2px; }
.ok-hero::before { background: linear-gradient(90deg, var(--ok), transparent 70%); }
@media (max-width: 560px) { .stage { padding: 10px; } h1 { font-size: 20px; } .versus { grid-template-columns: 1fr; } .versus-arrow { transform: rotate(90deg); } .tile-value { font-size: 28px; } .hero { padding: 16px; } }
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
