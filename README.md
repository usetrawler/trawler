<h1 align="center">
  <a href="https://usetrawler.com">
    <img src="https://usetrawler.com/assets/og-image.png" alt="Trawler — test your product the way people use it" width="820">
  </a>
</h1>

<p align="center">
  <b>People played by AI use your real product in a real browser.<br>
  A second agent replays every defect, blind, before it counts.</b>
</p>

<p align="center">
  <a href="https://usetrawler.com"><b>Website</b></a>
  &nbsp;·&nbsp;
  <a href="https://app.usetrawler.com"><b>Start&nbsp;testing</b></a>
  &nbsp;·&nbsp;
  <a href="https://usetrawler.com/docs/"><b>Docs</b></a>
  &nbsp;·&nbsp;
  <a href="#run-it-on-your-own-machine"><b>Run&nbsp;it&nbsp;locally</b></a>
  &nbsp;·&nbsp;
  <a href="mailto:contact@usetrawler.com"><b>Contact</b></a>
</p>

<p align="center">
  <a href="https://github.com/usetrawler/trawler/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/usetrawler/trawler/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="#use-it-in-the-app"><img alt="Hosted runs: private beta" src="https://img.shields.io/badge/hosted_runs-private_beta-B03711"></a>
  <img alt="Node.js 24 or later" src="https://img.shields.io/badge/node-%E2%89%A5_24-17191C">
  <a href="#licence"><img alt="Licence: Apache-2.0 and FSL-1.1-ALv2" src="https://img.shields.io/badge/licence-Apache--2.0_%2B_FSL--1.1--ALv2-2C4A57"></a>
</p>

## What Trawler does

Paste the address of your staging or preview environment. Trawler reads the page and proposes a few **people** — each with a situation, a temperament and things they care about — and the **goals** they want to get done. Then each person uses your product in a real browser, works through the goals and reports what went wrong on the way: a **defect** when something behaved wrongly, **friction** when it worked but slowed them down.

Nothing a person reports reaches the top of your report on their word alone. Every defect is replayed by a fresh agent that has never seen the claim, and a **judge** decides whether the replay saw the same thing. Only a defect the replay reproduces is **confirmed**.

## How it works

**01 · Paste a URL.** Trawler reads your product's page and, within a minute or two, proposes up to four people and six goals. Edit the people and goals — or just start.

**02 · Meet your users.** The people take their turns in your real product: clicking, typing and navigating as they see fit, working through every goal, and reporting defects and friction with the steps that led there. No scripts, no recorded flows to maintain.

**03 · Believe the second agent.** The fresh agent gets a defect's steps — not its title, not what the person saw, not the goal they were after — and follows them in a new browser. The judge compares what the replay saw with the claim and answers *confirmed*, *refuted* or *inconclusive*.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://usetrawler.com/assets/diagrams/how-a-defect-is-checked-dark.svg">
    <img src="https://usetrawler.com/assets/diagrams/how-a-defect-is-checked-light.svg" width="520" alt="Diagram: the fresh agent gets the steps, not the claim, and the judge compares what it saw with the claim.">
  </picture>
</p>

**04 · Act on what was confirmed.** The report opens with the defects a fresh agent reproduced, each with its steps, what the person saw and what the replay saw.

## Who it is for

- **Teams with a staging or preview environment** who want to know where a first-day user gets stuck before a first-day user does.
- **Anyone who built something quickly** — a prototype, a proof of concept, a new feature — and wants it used by someone who is not its author.
- **People who would rather read five confirmed defects than fifty guesses.** A run costs a few dollars on your own model key.

It is not a scripted test suite, a load test or a security scan. The people decide how to reach each goal, one person at a time, and report what they saw in the browser — not opinions about the design.

## Your product stays yours

- **Credentials.** Test account passwords are typed by Trawler, not the model, and only into a real password field on an allowed origin. Every password and secret a run knows about is masked as `•••` in what the model reads and what the run records.
- **Reach.** A browser limited to your product's own origins — every other request is stopped before it is sent — and a handful of tools: no shell, no file system, no uploads, no JavaScript in the page.
- **Spend.** In the app, a run is estimated before you start and capped while it runs: $2 by default, $50 at most. A model with no known price, such as one on an OpenAI-compatible service, gets no estimate, and its run stops after 3 million tokens. Only through OpenRouter, which reports each call's cost, is it held to the dollar cap as well, so watch your provider's billing. The local runner caps a run at `--budget`, $5 unless you set it. Either way, the last call can take a run slightly past its cap.
- **Your key.** Runs in the app are billed to your workspace's own key — OpenRouter, OpenAI, Anthropic, Google or any OpenAI-compatible service. Trawler adds nothing on top, and setting up a project in the app costs you nothing.
- **Isolation.** The model key and passwords are encrypted at rest, runners never hold the model key, and the database itself keeps each workspace's rows from every other.
- **Execution.** Hosted at app.usetrawler.com, or entirely on your own machine with the runner in this repository.

The details are in [Security and data](https://usetrawler.com/docs/reference/security-and-data/), including what masking cannot hide, and in [Models, estimates and the cap](https://usetrawler.com/docs/models/models-and-cost/).

## Use it in the app

> [!NOTE]
> Hosted runs are in a private beta. Anyone can sign in, analyse a product and edit its plan; starting a run needs an email address on the beta list — write to [contact@usetrawler.com](mailto:contact@usetrawler.com?subject=Trawler%20private%20beta).

1. Open [app.usetrawler.com](https://app.usetrawler.com) and choose **Continue with GitHub** or **Continue with Google** — Trawler has no passwords of its own. Your first sign-in creates your workspace, unless your email address already has an invitation to one.
2. Put the address of the page a new user would open first into **Product URL** and, if you like, a few words such as *the new team-invite flow* into **Anything specific to test?** Then choose **Analyse product**.
3. Review the plan. The people under **These people will try it** and the goals under **What they want to get done** are yours to rename, rewrite, add to or trim. If your product needs an account, choose **Your product needs sign-in? Add a test account**, add one with **Add account**, and pick it under **Signs in as** for each person who should use it. Choose **Save plan** to keep your changes.
4. Scroll to the **Start** panel at the bottom of the plan page. The first time, an owner or admin of the workspace pastes an API key from your model provider. Pick a model (one is filled in for you) and read the estimate. Then set **Hard cap (USD)**, tick the box confirming that you are authorised to test the product and that it is not a production system with real people's data, and choose **Start run**.
5. Follow the run: cost against the cap, goals reached and a card for each person. You can close the tab; the run keeps going.
6. Read the report. **Confirmed** comes first: the defects a fresh agent reproduced and the judge agreed with.

Screen by screen: [Your first run](https://usetrawler.com/docs/getting-started/first-run/). What a run costs: [Models, estimates and the cap](https://usetrawler.com/docs/models/models-and-cost/).

## Run it on your own machine

The runner is the program that actually uses your product: it opens the browser, plays the people, replays the defects and asks the judge. The same program carries out hosted runs, and it can also run entirely on your machine — no Trawler account, no Trawler server — reaching whatever your machine can reach: `localhost`, a VPN, staging behind a password. Model calls go from your machine to OpenRouter, asking the providers behind it not to keep or train on the data; nothing goes to Trawler.

You need Node.js 24 or later and an [OpenRouter API key](https://openrouter.ai/keys); the local runner calls models through OpenRouter only. On Linux, add `--with-deps` to the Playwright command so it installs the libraries Chromium needs.

```bash
git clone https://github.com/usetrawler/trawler.git
cd trawler
npm ci
npx playwright install chromium
```

Then export your key, with your own in place of `sk-or-…`, in every terminal you run the runner from:

```bash
export OPENROUTER_API_KEY="sk-or-…"
```

Run the commands below from the `trawler` directory. Anywhere else, `npx` looks for `trawler-runner` on the npm registry, where Trawler has not published it; if it offers to install a package, say no.

### 1. Propose a plan

With your product's address in place of the example:

```bash
npx trawler-runner setup https://staging.example.com --focus "the new team-invite flow"
```

Setup reads the page and writes a name, a description, up to four people and up to six goals to `project.yaml` — the runner calls people *personas* — then prints what it wrote and what it cost, such as `wrote project.yaml: 4 personas, 5 goals, $0.004`.

### 2. Edit `project.yaml`

It is plain YAML: the people (`personas`), the `goals` every person works through, test `accounts`, and what the app does not offer yet — extra `allowedOrigins`, HTTP basic auth and headers for protected staging. It holds passwords, so setup writes it readable by you alone.

```yaml
name: Acme
targetUrl: https://staging.example.com/
description: Shared workspaces for small teams.
personas:
  - id: ana
    name: Ana
    brief: >-
      You run a small bakery and have ten minutes between orders.
      You give up on anything that needs a manual.
    accountRef: owner
goals:
  - id: invite-teammate
    instruction: Invite a teammate to your workspace.
accounts:
  - ref: owner
    username: ana@example.com
    password: a-long-test-password
httpCredentials:
  username: staging
  password: the-staging-password
```

### 3. Run it

```bash
npx trawler-runner run --config project.yaml
```

Every person takes a session in turn, then every defect is replayed and judged, all under one budget. Progress streams to the terminal — `role:ana started` for Ana's session, `judge:f1 confirmed` for the verdict on finding `f1` — and the run is written to `runs/<start time, UTC>/`:

| File | Contents |
| --- | --- |
| `report.md` | The cost against the budget, a table of the sessions, replays and judge calls, each person's goals, then the defects grouped as confirmed, inconclusive, refuted and not judged, and the friction |
| `summary.json` | The same results as data |
| `events.jsonl` | Everything that happened, one event per line, written as it happens |

A confirmed defect in `report.md` reads like this:

```markdown
### Inviting a teammate fails with "Permission denied"
defect, high, ana / invite-teammate

After choosing Send invite the page says "Permission denied", and Members still lists only Ana.

1. Open https://staging.example.com/settings/members
2. Click "Invite teammate"
3. Type teammate@example.com into the Email field
4. Click "Send invite"

Replay: carried out every step. After "Send invite" a red banner reads "Permission denied"; the member list is unchanged.
```

| `run` option | Default | Meaning |
| --- | --- | --- |
| `--config <file>` | required | The project file to run |
| `--model <id>` | `deepseek/deepseek-v4.1-flash` | The OpenRouter model that plays the people and carries out the replays |
| `--judge-model <id>` | the same as `--model` | The model that judges |
| `--budget <usd>` | `5` | The cap for the whole run, in dollars, checked after every step |
| `--max-steps <n>` | `120` | Steps for each person's session |
| `--replay-steps <n>` | `40` | Steps for each replay |
| `--headed` | | A visible browser instead of a hidden one |

Exit codes, the other `setup` options and every field of the project file: [The local runner](https://usetrawler.com/docs/runner/local-runner/).

## Not built yet

In case you go looking:

- comparing a run with an earlier one;
- people using the product together;
- screenshots on findings;
- inviting teammates to a workspace, or switching between workspaces;
- deleting a project, a run or the model key;
- handing runs from the app to a runner inside your own network;
- reaching staging behind basic auth or a secret header from the app — the local runner covers private addresses and protected staging today.

Hosted runs stay in a private beta until Trawler can verify that you control the product you point it at. The runner is not published as a package yet; you run it from a checkout.

## Inside this repository

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://usetrawler.com/assets/diagrams/a-hosted-run-dark.svg">
    <img src="https://usetrawler.com/assets/diagrams/a-hosted-run-light.svg" width="520" alt="Diagram of a hosted run: the runner calls models through the control plane, which adds your key, so the runner never holds it.">
  </picture>
</p>

In a hosted run, the runner takes jobs from the control plane, streams events back to it and calls models through it; the control plane adds your key to each call, so a runner never holds it. Run locally, the runner needs neither the control plane nor Postgres: it reads `project.yaml` and calls OpenRouter itself.

| Path | Licence | What it is |
| --- | --- | --- |
| [`apps/runner`](apps/runner) | Apache-2.0 | `trawler-runner`: the people's sessions, blind replays and the judge — on your machine (`setup`, `run`) or for the hosted app (`work`) |
| [`packages/protocol`](packages/protocol) | Apache-2.0 | The zod schemas both sides share: the project file, findings, run events and the runner API |
| [`packages/core`](packages/core) | FSL-1.1-ALv2 | The engine: the agent loop, the browser and its origin allowlist, secret masking, setup, replay and the judge |
| [`apps/control-plane`](apps/control-plane) | FSL-1.1-ALv2 | The app at app.usetrawler.com: sign-in, workspaces, plans, runs, the runner API and the model proxy |
| [`db`](db) | FSL-1.1-ALv2 | The Postgres schema as Flyway migrations, with row-level security per workspace |
| [`scripts/release`](scripts/release) | FSL-1.1-ALv2 | Releases: staging, a smoke check, then production |

Built with TypeScript on Node.js 24, Next.js, Postgres with Flyway and Kysely, Better Auth, the Vercel AI SDK with Playwright MCP, zod and Vitest.

## Development

You need Node.js 24 or later, and Docker, which runs Postgres 18 and Flyway for the database tests. On Linux, add `--with-deps` to the Playwright command.

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm run test:unit
npm run db:up
npm test
```

`npm run test:unit` runs the tests that need no database; `npm test` runs them all, once `npm run db:up` has started Postgres on `localhost:54329`. Every pull request runs the same checks in CI, plus the migrations, the generated database types and the control plane's production build.

| Command | What it does |
| --- | --- |
| `npm run db:migrate`, `npm run db:validate` | Apply or check `db/migrations` on the local database |
| `npm run db:codegen` | Regenerate `apps/control-plane/src/db/types.ts` from the migrations |
| `npm run db:down` | Stop the local database |
| `npm run control-plane` | Start the app in development; it reads its configuration from the environment, in [`env.ts`](apps/control-plane/src/server/env.ts) |

## Reporting a vulnerability

Report vulnerabilities privately to [contact@usetrawler.com](mailto:contact@usetrawler.com?subject=Security%20report), not in a public issue.

## Licence

`apps/runner` and `packages/protocol` are [Apache-2.0](LICENSE-APACHE). Everything else is [FSL-1.1-ALv2](LICENSE-FSL), the Functional Source License: use, change and redistribute it for any purpose except offering it to others in a competing commercial product or service. Each release becomes Apache-2.0 two years after it is made available.

---

<p align="center">
  <b>Find what your users find first.</b><br>
  <a href="https://app.usetrawler.com">Start testing</a>
  &nbsp;·&nbsp;
  <a href="mailto:contact@usetrawler.com">contact@usetrawler.com</a>
</p>
