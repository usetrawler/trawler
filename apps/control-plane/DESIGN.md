# Control plane design

How the app at app.usetrawler.com looks, reads and behaves. This file is the one place for these rules: change it in the same pull request as a UI change that breaks one of them. The code it points to is the implementation; when they disagree, fix one of them.

## Principles

- **One focus per screen.** Each page answers one question first (what is open, what this run found, who tries what). Everything else is quieter.
- **Orange once.** At most one orange button per screen: the page's main forward action. Everything else is secondary or a text link.
- **No boxes by default.** Lists are rows divided by hairlines, not cards. A border appears only on a control, a callout or a chosen state.
- **Status first.** A run page leads with its verdict in plain words; numbers and details follow.
- **Same thing, same name, same look.** A label, a button or a message that means one thing is written and drawn one way on every page.

## Tokens

Colours are CSS variables in [`src/app/globals.css`](src/app/globals.css), exposed to Tailwind as `bg-paper`, `text-ink` and so on. Never write a hex colour in a component; the two exceptions are the text on an orange surface (`#171717`, readable in both themes) and the severity dots in [`src/runs/severity.ts`](src/runs/severity.ts).

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `paper` | `#f6f6f7` | `#0b0d13` | Page background, around the content panel |
| `panel` | `#ffffff` | `#151925` | The content panel, fields, menus |
| `ink` | `#171717` | `#eceef3` | Text, the focus ring, a chosen chip |
| `muted` | `#5c5c63` | `#a3a9b8` | Secondary text, meta lines, inactive tabs |
| `line` | ink at 10% | ink at 12% | Hairlines and field borders |
| `soft` | ink at 4.5% | ink at 6% | Hover, a chosen row, a disabled primary button |
| `action` | `#ff6b3d` | `#ff7a4f` | The one primary button, high severity, the first person |
| `action-ink` | `#c2410c` | `#ff8a63` | Orange used as text |
| `ok` / `warn` / `bad` / `info` | `#1d7a4a` / `#8a5a00` / `#b42318` / `#2f5f9e` | `#5ec48f` / `#e5b450` / `#f2766b` / `#8ab4ff` | Meaning only: done, attention, error, live |

Dark mode follows the system unless the account menu sets it; every screen is checked in both.

Type is Geist for everything and Geist Mono only for code-like strings: URLs, API keys and tokens, model ids, clock times on the timeline. Run numbers, plan names, counts and money are in Geist with `tabular-nums`. The body is 15px with a 1.6 line height.

People in a run get a colour from [`person-tones.ts`](src/app/runs/[id]/person-tones.ts), in order: action, ink, muted, then three mixes. Use `toneOf(index)` and `letterOf(name)`; the letter on a tone uses its `onBar` colour, which keeps 4.5:1 in both themes.

## Layout

- **The shell** ([`app-shell.tsx`](src/components/app-shell.tsx)) holds every signed-in page: the sidebar from 1024px (`lg`), a row of links across the top below that, and one content container, `max-w-[1100px]`, centred in the panel. Pages never set their own outer width or centre themselves.
- **One left edge.** Everything on a page — eyebrow, title, tabs, lists, forms — starts at the container's left edge (x=313 at 1440px wide). Nothing inside the shell is centred.
- **Two widths inside it.** Lists, tables, timelines and the plan editor take the full width. Forms, key-value tables and prose stop at `max-w-3xl` (768px), aligned left.
- **Phone (under 640px)** stacks everything in reading order. Rows of tabs or links that do not fit scroll sideways with `phoneEdgeFade`; nothing wraps into ragged rows and nothing scrolls the page sideways.
- **Pages outside the shell** — sign-in, welcome, the 404 page, MCP consent — have their own simple layout on `paper`, with the logo, and use the same tokens, controls and words.

## The page head

Use [`PageHead`](src/components/page-head.tsx) for every page title; [`ProjectHead`](src/components/project-head.tsx) wraps it for project pages and the run page follows the same anatomy.

1. **Eyebrow**, 14px muted: where you are. The workspace name on workspace pages (Overview, Findings, All runs, New project, Settings), the product's address on project pages, the breadcrumb on a run and its plan (`Overview › Project › Plan › Run 0017`).
2. **Title row**: the `h1` (`pageTitle`, 28px semibold, 24px on a phone) and, on the right, the page's actions. The row is at least 40px high, so tabs below sit at the same height whether a page has actions or not. The orange action goes last.
3. **Subtitle**, muted, optional: one sentence or one meta line.
4. **Tabs** where a page has sections: project (Home · Plan · Pull requests · Runs · Product), run (Findings · Timeline · Details), Settings (General · Members · Model & budget · API tokens & MCP · Billing). Use `tabRow`, `tab(on)` and `tabCount`: 15px medium for every tab, the open one marked by ink and a 2px bar so nothing shifts, at least 44px high. A count shows only when it is above zero.

A sentence that sums a page up (the Overview headline, the project Home headline) is the `h1` on a workspace page and one step below it, 22px medium, under a project's name.

## Headings

Two levels below the page title, from [`controls.ts`](src/components/controls.ts):

| Class | Size | Use |
| --- | --- | --- |
| `sectionTitle` (or plain `font-medium` at body size) | 15px medium | Every section of a page: Findings, People, Order of play, Confirmed, Goals |
| `formTitle` | 18px medium | The one title of a form step or a Settings panel: Members, Model key, Confirm the context. |

No other heading sizes. A count next to a heading is 14px muted with `tabular-nums`.

## Controls

All from [`controls.ts`](src/components/controls.ts); never hand-roll a control class.

- **Fields**: `field` (40px high, 12px padding, 14px text, 16px on a phone so iOS does not zoom), `area` for text areas, `keyField` for keys and URLs, `invalidField` while the server refuses the value. Every select gets the app's chevron from `globals.css`. A field has a visible label above it, never a placeholder instead of one.
- **Buttons**, 40px high, 6px radius:
  - `primaryButton`, orange: only the page's main forward action (Start run, Analyse product, Meet the test users). Disabled, it turns `soft` with muted text in both themes.
  - `secondaryButton`: everything else, including every Save in Settings, Copy as issue, Not a bug, Run again, Revoke and Disconnect.
  - `dangerButton`: only the confirming step of something that cannot be undone (Remove the key, Revoke, Pause and stop Run 0017). The first click asks; the red button confirms; a quiet text button keeps.
  - `textButton` and plain underlined links: navigation and small actions inside text.
- **Chips**: `chipOn` / `chipOff` for filters and the plan picker, 32px high.
- **Focus**: a 2px ink outline with a 2px offset on every focusable element; fields show a darker border and a soft ring instead.
- **Hit areas**: on a phone every link and button is at least 40px tall. A small inline link keeps its look and grows its hit area with `-my-2 inline-block py-2.5`.

## Feedback

- **Forms are `noValidate`.** The app checks the value and says what is wrong in its own words; the browser's bubbles never appear. The server checks again.
- **One look per meaning**, a 2px bar on the left and 14px text:
  - `errorNote`: what failed and what to do, right under the form or the control it belongs to.
  - `warnNote`: why an action is held (Devon needs a test account to sign in.) and page-level states (Runs on Acme are paused.).
  - `infoNote`: a neutral note about the content (Trawler could not tell from the page what the product does.).
- **Success** is one short green line next to the button that did it: Saved., Invited …, Disconnected.
- A message says what happened and what to do next; it never apologises and never repeats itself in a second place on the same screen.
- An empty state says what is not there yet and the one step that fills it. A section's explanation shows only when it has content.

## Words

Sentence case everywhere, no exclamation marks, no full stop on buttons and labels. The same thing has one name:

| Use | Not |
| --- | --- |
| **Start run** — the button that opens the start page; **Run from CI** on a product on a private network | New run, Start a run, Start another run, Set up runs from CI |
| **Run again** — repeats this run's plan with its model and cap | Rerun |
| **Change features** | Choose features and propose people |
| **Overview** for the workspace home, **Home** for a project's first tab | Projects, Dashboard |
| Run states: **Queued**, **Live**, **Complete**, **Stopped at cap**, **Stopped**, **Failed**, **Skipped** | Cancelled, Running, Done |
| Finding groups: **Confirmed**, **Unverified**, **Rough edges**, **Ruled out**; **Not a bug** for a dismissal | Friction, Inbox, False positive |
| **Findings** for open confirmed defects across projects | Inbox |
| **MCP** for runs an assistant started | Assistant |
| **a former member** for someone who left | someone no longer in this workspace |
| `Run 0017`, `PR #21`, `Plan 1` | run #17, PR 21 |

Times are local, `8 Nov 2026, 18:11`, from [`LocalTime`](src/components/local-time.tsx); a time on a run says which it is (started, finished). Money is `$0.20 of $10.00 cap`. Counts agree with their noun (1 goal, 2 goals).

## Motion

Only to show what changed: a 150–200ms colour or border transition on hover, the live dot, the "now" line on a live timeline, the spinner while setup works. Nothing slides in, nothing animates on page load, and `motion-safe:` guards every animation.

## Checking a change

- Unit tests render the markup and pin the important classes and words; update them with the rule, not around it.
- Before a UI pull request, open every screen it touches at 1440, 820 and 390 wide and in dark mode, and check: one left edge, no sideways scroll, no text under 12px, at most one orange button, no console errors, and hit areas on a phone.
- For a larger change, ask someone — or an agent — who does not know what changed to click through every page and list what disagrees between screens. Fix what they find, or change this file if the rule was wrong.
