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
  [--accounts <file>] [--cap <usd>] [--model <id>] [--fail-on new-confirmed|any-confirmed|never] [--plan-mode regression|change|both] [--replan] [--timeout-minutes 45] [--no-comment]
```

- `TRAWLER_API_TOKEN` is a workspace API token (Settings). `TRAWLER_API` is the default for `--api`.
- `--plan-mode` chooses what a pull request run executes. `change` (the default) runs only the plan Trawler makes for the pull request, with the people and goals the change calls for; if nothing in the change can be tried through the product's UI, no run is started: the CLI prints that, posts it as the pull request comment and exits 0. `regression` runs only the project's own plan, as for any run without a pull request. `both` runs the project's plan and adds the pull request's goals to it.
- `--replan` plans the pull request again even if its title, description and changed files have not changed since the last run; by default a pull request keeps its plan until they change.
- `--runner hosted` runs on Trawler's runners; `--runner own` runs the browser inside the CI job, so `--url` can be `http://localhost:...`.
- Exit codes: 0 pass, 1 confirmed defects (`new-confirmed` and `any-confirmed` behave the same until there is a baseline) or an API/auth error, 2 usage error. A run that hit its cap, the time limit, was cancelled or failed does not fail the job. When `--timeout-minutes` passes, the CLI stops the run first and then exits 0. When the CLI is interrupted (SIGINT, SIGTERM) or leaves before the run finished, it stops the run too. A run that no runner picks up within 20 minutes is cancelled by Trawler. If the runner started by `--runner own` cannot claim jobs for good (an unknown token, a runner too old for the server), it exits with the reason and the CLI fails the job.

## Accounts

When your boot script already creates the test users, hand them to the run instead of typing them into the plan. Have the script write a JSON file that maps each person's name in the plan to the account it created, and pass it with `--accounts` (needs `--runner own`):

```json
{
  "Daniel": { "username": "daniel@ci.test", "password": "a-long-random-password" },
  "Priya": { "username": "priya@ci.test", "password": "another-long-random-password" }
}
```

- The keys must match the people's names in the plan exactly. Up to 20 people, a file of at most 64 KB; `username` and `password` are non-empty strings.
- Only the names go to Trawler; the passwords stay in the job. The CLI points the runners it starts at the file through `TRAWLER_ACCOUNTS_FILE`, and they scrub the passwords from everything they report.
- A person named in the file who has no account stored in the plan gets the account from the file, whether the plan has them sign in or sign up. A person who already has a stored account keeps it.
- A person in the plan who signs in but is neither named in the file nor has a stored account makes the run refuse to start.
- Without `--accounts` nothing changes: signing-in people use the accounts stored in the plan.
