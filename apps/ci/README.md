# trawler-ci

Starts a Trawler run for a pull request, waits for it, comments the result on the PR and sets the job's exit code.

```yaml
- uses: actions/checkout@v4
- run: npm ci
- run: npx playwright install --with-deps chromium   # only for --runner own
- run: npm run start & npx wait-on http://localhost:3000   # your app, only for --runner own
- run: node apps/ci/src/main.ts run --project "$PROJECT" --url http://localhost:3000 --runner own
  env:
    TRAWLER_API: https://staging.usetrawler.com
    TRAWLER_API_TOKEN: ${{ secrets.TRAWLER_API_TOKEN }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}   # job needs pull-requests: write
```

Needs Node 24 or newer and `npm ci` at the repository root. No build step.

```
node apps/ci/src/main.ts run --project <uuid> [--plan <uuid>] [--url <address>] [--runner hosted|own]
  [--cap <usd>] [--model <id>] [--fail-on new-confirmed|any-confirmed|never] [--timeout-minutes 45] [--no-comment]
```

- `TRAWLER_API_TOKEN` is a workspace API token (Settings). `TRAWLER_API` is the default for `--api`.
- `--runner hosted` runs on Trawler's runners; `--runner own` runs the browser inside the CI job, so `--url` can be `http://localhost:...`.
- Exit codes: 0 pass, 1 confirmed defects (`new-confirmed` and `any-confirmed` behave the same until there is a baseline) or an API/auth error, 2 usage error. A run that hit its cap, the time limit, was cancelled or failed does not fail the job.
