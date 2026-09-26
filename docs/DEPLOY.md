# Deploying AVA

Two shapes. Pick one, then follow its section.

|  | A · Vercel + Render worker **(recommended)** | B · Vercel only |
|---|---|---|
| Interface | Vercel | Vercel |
| Database | Render Postgres | Render Postgres |
| Scanning | Render worker service, always on | Vercel Cron calling `/api/cron` |
| JavaScript careers pages | **Yes**, headless Chromium | **No** |
| Scan window | Unlimited | 60 seconds per run on Hobby, up to 300 on Pro |
| Runs per day | Continuous; on-demand work starts within seconds | 1 on Hobby, more on Pro |
| Cost | ~£11/month (worker ~$7, database ~$7) | ~£5/month (database only) |

**Take A unless the extra $7 a month matters.** Shape B cannot run a browser, and a careers page
whose roles arrive by JavaScript is exactly the case a browser exists for. Of the two examples in
the specification, `anthropic.com/careers/jobs` resolves fine without a browser because its listing
links straight to a hosted board; `anduril.com/open-roles` is the shape that needs one. In shape B
those companies land on the Health page as sources needing attention, and the fix is to paste the
underlying board URL by hand.

Everything else works identically in both: the same discovery, the same adapters, the same gate,
the same learning loop.

---

## Before either shape: the database

1. In Render, **New → Postgres**, named `ava-db` (the name `render.yaml` and the rest of this guide
   use). Any paid instance is fine; the free tier expires after 30 days. Note the region, and put
   the interface in a nearby Vercel region later.
2. Copy the **External Database URL**. It already carries `?sslmode=require`.
3. Create the tables from your own machine:

   ```bash
   git clone https://github.com/harrydryden/christopher && cd christopher
   pnpm install
   DATABASE_URL='<external database url>' pnpm db:migrate
   ```

   Migrations are safe to re-run; they take an advisory lock, so nothing is damaged if the worker
   starts at the same moment. A run waits about a minute at most for another to finish, and gives
   up on any table lock after ten seconds (then retries, six times in all) rather than queue the
   interface's reads behind it. It refuses to finish if any migration in the journal was left
   unapplied; writing a migration is covered in `packages/db/README.md`.

4. Generate the secret the interface needs:

   ```bash
   openssl rand -hex 32                                        # SESSION_SECRET
   ```

   Accounts live in the database, not in environment variables. `ADMIN_EMAILS` names the
   administrator addresses (default: `harryddryden@gmail.com`). Once the interface is up, sign up
   with that address, or use "Continue with Google" with it, and confirm the address: the
   confirmation link asks for your password. Only then does the account become an administrator.
   Nobody else can sign up until you open registration in Admin, and new members become
   administrators only if you promote them there. Optional extras: `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` (an OAuth 2.0 web client in Google Cloud with the redirect URI
   `https://<your host>/auth/google/callback`) add "Continue with Google"; `RESEND_API_KEY` and
   `EMAIL_FROM` send confirmation and password-reset links, and `APP_URL` must be set alongside
   them so the links carry your real address.

   **Upgrading a single-user deployment.** The migration keeps your companies, roles, decisions,
   profile, library, CVs and settings under a placeholder owner. The administrator address takes
   that owner over, with everything in it, the moment it is confirmed or signs in with Google.
   Any other address gets an empty workspace. `APP_PASSWORD_HASH` and `APP_PASSWORD` are no
   longer read and can be removed.

   **Without Resend.** Confirmation and reset links are written to the server log (Vercel's
   function logs); copy the link from there. An administrator can also mint a reset link for any
   account from Admin › Accounts; using it confirms the address as well.

5. Decide which endpoint each client uses. Render gives the database two: **direct** on port 5432
   (the Internal and External URLs), and **pooled** through PgBouncer on port 6432, which pools by
   transaction (see [Render's connection-pooling documentation](https://render.com/docs/postgresql-connection-pooling)).

   | Client | Endpoint | Why |
   |---|---|---|
   | The interface on Vercel, `/api/cron` included | pooled, 6432 | Every warm function instance keeps a pool of up to 3 connections. It uses only transaction-scoped locks, so transaction pooling is safe for it. |
   | The worker | direct, 5432 (Internal) | It migrates at boot under a session advisory lock, which transaction pooling cannot hold; the migration runner refuses a pooled URL. |
   | `pnpm db:migrate`, `seed:demo`, the drills | direct, 5432 (External) | The same lock, from your machine. |

   **The arithmetic.** The database allows 103 backends (`max_connections`), three of them reserved
   for superusers. The worker holds up to `2 × (WORKER_CONCURRENCY + CV_CONCURRENCY) + 4` = 26 at
   the supported three general slots and eight CV slots. On the direct endpoint every warm interface instance holds up to 3 more, so
   about 30 instances (fewer during a rollout, when old and new are both warm, or with the cron
   fallback's own pool of 6) exhaust the database, and every page fails with "too many clients" for
   every account at once. Through PgBouncer an instance's connections are clients, which hold no
   backend while idle; PgBouncer opens backends only for transactions in flight, up to Render's
   default of `max_connections − 10` = 93. Keep PostgreSQL's active backends under about 70 in
   steady state (`select count(*) from pg_stat_activity where state = 'active'`), leaving room for
   the worker, migrations and your own `psql`.

   **Time limits.** The worker and the scripts start every connection with a `statement_timeout` of
   five minutes and an `idle_in_transaction_session_timeout` of one (`DATABASE_STATEMENT_TIMEOUT_MS`
   overrides the first). PgBouncer refuses such startup parameters, so a pooled connection sends
   none. Set them once on the database role instead, so the interface's statements are bounded too
   and a query left behind by a function the platform killed does not run on holding its locks:

   ```sql
   ALTER ROLE <database user> SET statement_timeout = '30s';
   ALTER ROLE <database user> SET idle_in_transaction_session_timeout = '60s';
   ```

   Direct connections replace the role's values with their own, and migrations set their own for
   the migration session. A `psql` session inherits the 30 seconds: `SET statement_timeout = 0`
   first for anything long, such as building an index `CONCURRENTLY` by hand.

---

## Shape A · Vercel + Render worker

### The worker

Render can read `render.yaml` from the repository: **New → Blueprint**, point it at the repo, and it
creates the worker service (it will also offer to create a database; skip that if you made one
above). Or create it by hand: **New → Web Service**, runtime **Docker**, Dockerfile path
`Dockerfile`, Docker context `.`, health check path `/healthz`, instance type
**Starter** (the free type sleeps, which stops the scheduler), in the database's region
(`render.yaml` says Frankfurt, beside the interface's `fra1`).

Two more settings a service made by hand does not get from the blueprint:

- **Build Filters** (Settings → Build & Deploy): include only `apps/worker/**`, `packages/**`,
  `Dockerfile`, `.dockerignore`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`
  and `tsconfig.base.json`, the list in `render.yaml`. A merge that touches only the interface or
  the documentation then leaves the worker running, instead of restarting it and interrupting the
  scans and CV builds in flight. The release check accepts a worker still on the last commit that
  changed one of these paths (see [Continuous integration](#continuous-integration)), so the two
  lists must match; `scripts/deploy-config.test.mjs` holds `render.yaml` to it.
- **Docker Command**: leave it empty. The image starts `tini` as PID 1 and Node under it, as the
  unprivileged `pwuser`; a command set here replaces that.

The image runs under `tini` so that the renderer, GPU and zygote processes a crashed Chromium
leaves behind are reaped rather than accumulating, and as `pwuser` rather than root because
Chromium renders untrusted careers pages with its sandbox off (containers rarely allow the user
namespaces the sandbox needs) in a process that holds the database URL and the API key.

### Linking the database

`DATABASE_URL` is the one value that cannot be set through the API, because Render never exposes a
database password over it. In the dashboard, open the worker service, go to **Environment**, add a
variable named `DATABASE_URL`, and use the database picker in the value field to select
**ava-db → Internal Connection String**. Saving triggers a redeploy.

Until it is set, the worker builds and starts but exits with `DATABASE_URL is required`.

Set these on the service:

| Variable | Value |
|---|---|
| `DATABASE_URL` | linked from the database as above; use the **Internal** string when the service and database share a region |
| `ANTHROPIC_API_KEY` | your key. Without it, scanning still works and scoring is skipped |
| `SCRAPER_CONTACT_EMAIL` | an address you read; it goes in the user agent. **Required**: in production the worker refuses to start without one, or with a placeholder such as `you@example.com` |
| `ADMIN_EMAILS` | the same list as the interface's. The worker warns at boot when it is unset |
| `TZ` | e.g. `Europe/London` |
| `WORKER_CONCURRENCY` | `3` — the supported value for the 512 MB Starter instance shared with Chromium. These are the general slots (scans, discovery, imports, scoring); they never run a CV build. Six slots caused an observed ten-hour out-of-memory restart loop on a 41 MB listing; use six only after increasing the instance size and proving memory and database headroom under a representative soak |
| `CV_CONCURRENCY` | `8` (the default; 1–30) — slots of their own for CV builds, beside the general ones. A build holds its slot for many minutes but mostly waits on the model, so it is sized apart from the memory budget: the load harness ran 50 accounts × 2 CVs through eight slots at a peak heap of about 90 MB. The database pool is `2 × (WORKER_CONCURRENCY + CV_CONCURRENCY) + 4` = 26 connections at 3 and 8. Each build is admitted against its account's budget one stage at a time, so an account's builds run side by side while its month can afford the stages in flight |
| `WORKER_STATUS_TOKEN` | a long random string; the bearer token the worker's `/status` figures require. Give the operational check the same value (see [Release gates](RELEASE-GATES.md)) |
| `LOG_LEVEL` | `info` (the default), or `debug`, `warn` or `error`, in any case |

The first line a production worker writes, `worker environment`, records the slots, the browser
slots, the database pool's ceiling and the V8 heap limit it was given, so a restart loop can be read
against what the process actually had.

The worker and migration runner must use Render’s **direct port 5432** database URL: the session advisory migration lock is incompatible with transaction pooling. The migration runner rejects known Render pooled URLs on port 6432 before connecting. The interface uses the **pooled port 6432** URL (step 5 of the database section has the reasons and the arithmetic); enabling PgBouncer alone does not switch existing clients. See [Render’s connection-pooling documentation](https://render.com/docs/postgresql-connection-pooling).

The worker runs migrations on boot under an advisory lock. That makes concurrent migration attempts
safe; it does not by itself prove that an older release can run against every newer schema. Follow
the rollout and recovery checklist below. Check `/healthz` returns `{"ok":true,…}` and the logs show
`worker starting`.

### The interface

In Vercel, **Add New → Project**, import the repository, then set **Root Directory** to `apps/web`.
Leave the build and install commands alone: Vercel detects the pnpm workspace and installs from the
repository root.

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **pooled** External database URL, on port 6432 (see step 5 of the database section). Not the direct 5432 URL: about 30 warm instances on it exhaust the database |
| `SESSION_SECRET` | from above |
| `APP_URL` | `https://<your vercel host>`; used in emailed links and the Google redirect |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional, for Google sign-in |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional, for confirmation and password-reset emails |
| `ADMIN_EMAILS` | optional, see step 4 above; defaults to the owner's address |

The interface has guarded reads for a short deployment skew, but that is a recovery measure rather
than the release order. Apply migrations first, deploy and verify the interface second, then deploy
the worker. The worker is last because it is the component that can first write a new lifecycle
state such as `awaiting_evidence`; the corresponding interface must be live before a person can be
left at that checkpoint. A database missing migrations altogether is a different thing — the
"every page 500s right after deploy" row below.

Vercel's egress addresses vary, so the database is protected by TLS and a strong password rather
than an IP allowlist. Leave `CRON_SECRET` unset and the daily cron in `apps/web/vercel.json` is
harmless: without the secret the route refuses anonymous calls, and the worker is doing the work
anyway. Set it if you want the cron as a safety net; duplicate runs are deduplicated per day. A
safety net also needs `SCRAPER_CONTACT_EMAIL` on Vercel, because the route runs the worker's code
when the worker is down, and that code refuses to fetch anything without a real contact address.

---

## Shape B · Vercel only

Deploy the interface exactly as above, and add:

| Variable | Value |
|---|---|
| `CRON_SECRET` | `openssl rand -hex 32`. Vercel sends it as `Authorization: Bearer …` on every cron call |
| `ANTHROPIC_API_KEY` | your key |
| `SCRAPER_CONTACT_EMAIL` | an address you read. Required: the cron route runs the worker's code, which refuses a missing or placeholder address in production |
| `AVA_DISABLE_BROWSER` | `1`. There is no Chromium in the Vercel runtime |
| `AVA_SERVERLESS_FALLBACK` | `1`. Without it the route only queues work; with it the route also runs the queue itself (see below) |
| `TZ` | e.g. `Europe/London` |

A deployment made before the rename may still set `CHRISTOPHER_DISABLE_BROWSER` and
`CHRISTOPHER_SERVERLESS_FALLBACK`. They are still read wherever the new names are unset, so nothing
changes on deploy; rename them in the dashboard when convenient.

`apps/web/vercel.json` already declares the schedule (`0 6 * * *`). Change the time there if you
want; on Hobby, Vercel runs cron jobs approximately, not to the minute.

On a paid plan, raise `maxDuration` in `apps/web/app/api/cron/route.ts` from 60 to 300 so a whole
run finishes in one invocation.

### Living without a worker

- **`AVA_SERVERLESS_FALLBACK=1` is what makes the route do the work.** Without it the cron
  route only ticks the scheduler — it queues the day's run and the weekly jobs, and nothing runs
  them. With it, the same invocation works through the queue until its time is nearly up. Its
  limits are real: no browser, so a JavaScript careers page still cannot be scanned; and each task
  it starts must finish inside `maxDuration` (60 seconds on Hobby, up to 300 on Pro), so a long
  scan can be cut short and retried on the next call. It is a fallback, not a second worker.
- **Beside a worker it stands down.** If the Render worker has reported a heartbeat in the last two
  minutes, the route neither ticks the scheduler nor claims a task, and answers
  `{"ok":true,"processed":0,"standDown":"worker"}`. Leaving the cron enabled after moving to shape A
  is therefore harmless.
- **The queue only moves when the route is called.** Buttons in the interface that say "run now"
  add work to the queue; nothing processes it until the next cron. To run it immediately, visit
  `https://<your app>/api/cron` while signed in. A session is accepted as well as the bearer token.
- **A run that hits the time limit stops cleanly** and reports `timedOut: true`. Whatever is left
  stays queued for the next call, so nothing is lost, but on Hobby that means tomorrow.
- **JavaScript careers pages will not resolve.** They appear on Health as needing attention. Open
  the company, paste the underlying board URL (the `boards.greenhouse.io/...` or
  `jobs.lever.co/...` address), and it is scanned normally from then on.

Moving to shape A later is only a Render deploy: add the worker service, unset
`AVA_DISABLE_BROWSER` and `AVA_SERVERLESS_FALLBACK` (and their old `CHRISTOPHER_*` names, if the
deployment still sets them), and the same database keeps
every company, role and decision.

---

## First run

1. Sign in with the password you hashed.
2. **Settings** → set your keywords, your locations (`London`, `UK`), your timezone, and paste a few
   sentences into the seed profile.
3. **Companies** → paste your homepage URLs, one per line.
4. Wait for discovery, or trigger a run: shape A picks it up in seconds; in shape B visit
   `/api/cron`.
5. **Health** shows anything that needs you: a company whose careers page could not be found, a
   blocked site, or a source needing confirmation.
6. **Admin › Accounts** lists everyone sharing the deployment, what each has produced and follows,
   and what each may spend on AI in a month. New accounts start at $25; raise one there.

## The operational CLI

`apps/worker`'s CLI (`pnpm cli <command>`, listed in the README) is run by hand, often from a
checkout on a laptop against the production database, so it is careful in two ways.

- **Only `cli migrate` migrates.** Every other command — the dry-run `probe` and the read-only
  `users`, `list` and `table` included — first compares the checkout's migration journal with the
  database's ledger and refuses, changing nothing, when the database is behind the checkout (it
  names the migrations that are not applied) or was migrated by a newer release. Looking at
  production from a branch that carries an unreleased migration therefore cannot apply it.
- **It never widens a mistyped target.** `cli discover <company> [careers-url]` acts on exactly one
  company, found by id, domain (or a URL on it) or exact name, and refuses a needle that matches
  none or several. The whole active catalogue is `cli discover --all`, which refuses a careers URL.

- **`record` and `replay` never publish.** They rebuild a draft to grade it, inside a rolled-back
  transaction, and never touch the draft, the budget or the queue (see "Evaluation reports and the
  prompt set"). `record` and a `replay` without `--recordings` call the provider and are paid; both
  refuse without `ANTHROPIC_API_KEY`.

Inside the worker's container (Render's Shell), run it without pnpm, from `/app/apps/worker`:
`node --import tsx src/cli.ts users`.

## Continuous integration

Two workflows. **CI** (`.github/workflows/ci.yml`) runs on every pull request and again on
every push to `main`; **Release** (`.github/workflows/release.yml`) runs only after CI has
passed on `main`.

CI is three jobs side by side, each on its own runner with its own throwaway PostgreSQL 16:

| Job | What it runs | Typical |
|---|---|---|
| `check` | `pnpm -r typecheck`, then `pnpm -r test`, then the release and deployment script tests | ~2.5 min |
| `browser-and-smoke` | Chromium install, the headless browser test, `pnpm db:migrate`, `pnpm smoke:web` (a production `next build`, sign-in, every page, and the CV workspace driven through Playwright) | ~2.5 min |
| `worker-image` | `docker build` of the image Render deploys, then boots it against the job's database and waits for `/healthz`, and checks it runs as a non-root user under `tini` | ~4 min cold (estimated, not yet measured on a runner), less with the dependency layer cached |

So a pull request is green in about four minutes of wall clock for about nine billed minutes.
`worker-image` is what catches a Dockerfile that no longer builds, a workspace manifest the image
does not copy, a Playwright bump without the matching base image, or an import that fails only
when the worker starts — all of which would otherwise surface first as a failed Render deploy
after the merge. A pull request is checked once, on its merge result: pushing to a branch no
longer starts a second, identical run. A new push cancels the run still working on the commit
it replaced, so only the newest commit holds a runner. Runs on `main` are never cancelled,
because the release check is gated on them.

Two caches keep the slow steps honest but cheap. Chromium is cached at `~/.cache/ms-playwright`
under the `playwright` version resolved from `pnpm-lock.yaml`, so a bump downloads it again and
nothing else does; `playwright install --with-deps` still runs, and on a hit only settles the
operating system packages. The Next.js build cache is kept at `apps/web/.next/cache` under the
lockfile plus a hash of `apps/web`'s sources, with the lockfile-only key as a fallback, so the
smoke build reuses its compilation. Caches written on a branch are private to that branch, so
it is the `main` run that fills them for everyone; the first run after a change to either key
is a cold one.

`worker-release` is the last thing to go green after a merge. It polls the live worker's
`/healthz` — up to eight minutes — until it reports the merged commit, or an earlier commit from
which no worker input has changed, and fails if it never does. That is the only check that a
*worker* deployment happened: Vercel deploying the interface says nothing about CV generation or
scanning, which the worker alone does. It is
deliberately not on pull requests, where nothing has been deployed and there is nothing to
verify; before, it appeared there as a skipped job, which reads like a problem. It runs from
the `Release` workflow on the commit CI passed on, named explicitly through `RELEASE_SHA`
because a `workflow_run` job's own `GITHUB_SHA` is the branch tip rather than that commit.

The earlier-commit case is a merge that touched only the interface or the documentation: Render's
build filter skips the deploy, so the worker correctly stays on the last commit that changed it,
and neither this check nor the scheduled operational check calls that stale. Both check out full
history to make the comparison. The list of worker inputs is `WORKER_INPUT_PATHS` in
`scripts/release-checks.mjs`, the same list as `render.yaml`'s build filter.

## Evaluation reports and the prompt set

Every prompt the engine sends is an entry in `packages/ai/src/prompt-registry.ts`, and
`promptSetVersion()` is one hash of all of them. The committed reports under
`docs/evaluations/<name>/report.json` say which prompt set they were graded at, and CI's `check`
job holds them to the registry (`scripts/check-evaluation-reports.ts`):

- a report graded at another prompt set fails the job unless it is marked `"unverified": true` — a
  report kept for the record that no longer vouches for the shipped prompts;
- at least one report must be at the shipped prompt set, so a prompt change cannot merge without a
  report written at its version.

`docs/evaluations/cv-replay/report.json` is that report. It is written by the replay command:

```bash
cd apps/worker
pnpm cli record <draft-id>                        # live and paid: refuses without ANTHROPIC_API_KEY
pnpm cli replay <draft-id> --recordings ../../docs/evaluations/recordings/<file>.jsonl \
  --out ../../docs/evaluations/cv-replay/report.json
```

`record` rebuilds the draft through the real handler against the provider and writes every model
call to a JSONL recording in `docs/evaluations/recordings/` (gitignored: it holds CV text). `replay`
rebuilds the same draft from that recording with no key and no cost, grades it — every claim
supported, weighted coverage not lower than the recorded run's, the page limit met, no essential
requirement losing points, plus the structural diagnostics the build itself uses — and writes the
report with the prompt set, the route every CV stage ran at, the cost and the wall time. Neither
command changes anything: the rebuild runs inside a database transaction that is always rolled
back, on a copy of the draft under a scratch account, with a budget sink that holds nothing and
records nothing, so the draft, the account's budget, `ai_calls` and the task queue are untouched. A
recording answers only the requests it holds: an edited prompt, a different input or another
model or effort fails the replay, naming the prompt and version, and never reaches the provider.

The expected workflow for a pull request that edits a prompt:

1. Run the edited build live on a representative draft: `pnpm cli record <draft-id>` against a
   database that has one (a development copy, or production from a checkout: both commands only
   read). This spends that one build's cost.
2. Replay it into the report: `pnpm cli replay <draft-id> --recordings <file> --out
   docs/evaluations/cv-replay/report.json`. The report is at the new prompt set and, because the
   recording came from the provider, is not marked unverified.
3. Commit the report with the prompt change. Its grade is what a reviewer reads.

Where no key is available (CI, a contributor without one), the mechanism still runs end to end on
the scripted client: `DATABASE_URL=<scratch database> pnpm exec tsx scripts/cv-replay-fixture.mts
docs/evaluations/recordings/cv-replay-fixture.jsonl` publishes a synthetic draft and records its
rebuild through the scripted client, and replaying that recording writes a report marked
`"unverified": true` — the recording says its answers were scripted. That satisfies the gate while
saying plainly that no model graded the new prompts; replace it with a live report before relying
on the change. The report committed today is of this kind.

## Costs

| | |
|---|---|
| Render Postgres, smallest paid instance | ~$7/month |
| Render worker, Starter (shape A only) | ~$7/month |
| Vercel Hobby | $0 |
| Anthropic API, 30 companies in steady state | ~$3–10/month |

Every account has its own monthly AI budget, $25 to start, and it is the only budget the product
has. Each person sets their own on **Settings**; an administrator sets anyone's in
**Admin › Accounts**, which shows what each account has spent this month and can start an account's
month again with Reset spend. The budget runs on the calendar month in UTC and starts again on the
1st; a reset moves the window the spend is counted in rather than deleting anything, so
**Admin › Operations** still reports every call made, by account, feature and model, and totals the
month's spend across every account and the work no account asked for. An account's optional model
calls (company and filter suggestions) stop once it has spent its month. A CV build costs about
$3 on Fable 5.1 (a 35 KB library against a typical advert); it is admitted against that account's
budget once, up front, at that expected cost, and a build the account cannot afford fails before it
spends anything, naming the budget, what is left and what its calls in flight are holding.

Work no account asked for — extraction, discovery — is charged to no budget. `DAILY_AI_BUDGET_USD`
and `DISCOVERY_AI_BUDGET_USD` in the worker's environment are the safety valves for the deployment
as a whole: unlimited unless set, they cap a day's spend and a day's discovery spend across every
account, and they refuse any call, a CV build included, so leave them unset unless you want that.

### The database disk

Render's smallest Postgres plans start with **1 GB of storage and storage autoscaling off**, which
is what the live database had on 20 September 2026 (15% used under light load). That is not enough
for the deployment this guide describes. Every posting ever observed stays in `jobs` with a
description of up to 30,000 characters; each account's view of a role is a `user_jobs` row with its
own rationale and indexes (about a million rows at 1,000 accounts and 150,000 postings); scans keep
raw snapshots; `tasks` keeps thirty days of finished work; `ai_calls` keeps thirteen months; and
every Library save and CV keeps its own copy of the Library. A reasonable estimate at that scale is
well over 1 GB, and **a full disk stops every write**: sign-ins (a session is a row), task claims and
scans all fail at once, until someone changes the plan by hand.

- Before onboarding beyond a handful of accounts, set the database's storage to at least **15 GB**
  (the flexible plans size storage separately from RAM and CPU; `render.yaml` writes 15) and turn
  on **storage autoscaling** in the dashboard, which the blueprint cannot. Storage can grow later but
  never shrink. At that scale also move off `basic-256mb`: 256 MB of RAM cannot keep `user_jobs`'
  indexes in memory.
- Watch the disk figure on the database's Metrics page, and treat 70% as the point to add storage.
  Nothing in the product alerts on it yet; add it to the alert list below.
- Connections are a separate budget from disk: the worker opens up to `2 × (WORKER_CONCURRENCY + CV_CONCURRENCY) + 4` direct
  connections (26 at three general and eight CV slots), and the interface should use the pooled URL, as the connection
  guidance above describes.

## Observability

Nothing here is a metrics stack. A handful of ledgers in the database carry what Operations needs
to answer a question after the fact, and the pages under **Admin › Operations** read them.

| Ledger | What it records | Written by | Retention |
|---|---|---|---|
| `worker_events` | Boots, shutdowns, crash recoveries and their suspect tasks, abandoned tasks, deadline abandonments, released budget holds. One row per notable thing the process did. | The worker | 30 days |
| `http_host_daily` | Outbound traffic per host per day, per path (the polite fetcher or the headless browser): requests, bytes, status classes, 304s, rate limits, blocks, robots denials, cap rejections, timeouts, network errors, and a six-bucket latency histogram. Counters, flushed in batches. | The fetcher and the browser | 400 days |
| `ai_calls` | One row per model call: call site, stage, model, tokens, cache reads and writes, cost, duration, outcome, the account it was for and what it was about. | The AI engine, through every worker handler | 13 months |
| `scans` | One row per scan: status, fetch method, postings, bytes fetched, requests made and how many came back 304, duration. | The scan handler | 90 days, keeping each source's last three and its last successful one |
| `cv_build_steps` | One row per motion of a CV build — reading the Library, reserving the budget, the rubric, each writing attempt, each measurement and trim, each assessment batch, scoring, saving — with its attempt, timing, figures, cost, outcome and, when it stopped, the classified failure. The CV page narrates them; Operations aggregates them by motion and by failure kind. | The CV build handler | With the draft (deleted on cascade) |
| `tasks` | The queue itself: type, payload, attempts, error, timings. | The queue | 30 days after finishing |

Retention is enforced by the worker's hourly `maintainHistory`, each statement bounded so an hour's
cleanup never holds a long transaction. `ai_calls` keeps thirteen months — a full year plus the
month being reconciled — because a spend question can be asked about last year's invoice, and
because resetting an account's budget moves its window rather than deleting its calls.

**What stays a log line, deliberately.** The per-request `http fetched` line, the per-task heap
readings, and the detail of a robots decision are logged and not stored. They are per-request
volume with no aggregate to answer: the rollup already carries the shape of a host's traffic, and
keeping a row per request would cost more than it explains. The log is for reading one incident
while it is fresh; the ledgers are for the questions asked a week later, once the platform has
dropped the logs.

### Answering four questions

**"Is a vendor throttling us?"** Operations › Outbound traffic. Find the host and read *Throttled*:
above 1% it is in warn tone, and that host is pacing us deliberately. *Blocked* above zero is worse
— it is refusing us. Both are answered by slowing that host down, not by retrying it; the
week-on-week column says whether it started recently. A host whose p95 has moved into "over 15s" is
slow rather than throttling, which is a different fix.

**"Why did this CV build cost more?"** Operations › Cost per build. Each of the last twenty builds
is itemised by stage. For one build in particular, open its CV and its **build log**: the motions
it ran, what each produced, how long it took and what it cost, with the total at the top.
Operations › CV build motions is the same ledger across every build, which is where a motion that
is dear or failing everywhere shows up. `review_retry` means the audit's source attribution had to be corrected and
one batch was paid for twice. A large `rubric` and `author` with no retry means a long job
description and a long library — a dear input, not a fault. Compare the build against the median on
the same card before treating it as an outlier.

**"Is Greenhouse (or Ashby) scanning efficiently?"** Two cards together. Outbound traffic gives that
host's requests, bytes and 304 share for the week: a high 304 share is the good case, because those
requests transferred nothing. Largest scan inputs names the individual boards behind the bytes,
with the fetch method and each scan's requests and revalidations. A board on the `http` method with
most of its requests revalidated is cheap however large it is; one on `browser`, or one fetching
megabytes fresh every day, is the one to add an adapter for.

**"Is the worker healthy?"** Operations › Background worker for the state (`healthy`, `restarting`,
`stopped`), the crash-recovery count and the heap reading against the ceiling, then Recent worker
events for what it has actually been doing. `/healthz` on the worker serves the same vitals for an
uptime check. The runbook below covers a worker that is restarting.

### Why it is shaped this way

The unit of observation is the external dependency, because that is where this system fails:
every host we fetch from and every model call has an availability, a latency and an error rate, and
`http_host_daily` and `ai_calls` are those three SLIs for each. Around them: structured logs that
carry the task's id and type on every line, so one incident can be read end to end; a health
endpoint with process vitals, so a scheduler can restart a worker that has stopped answering; and
ledgers rather than log search, because the hosting platform drops logs on its own schedule and the
questions above are usually asked after it has. A rollup is cheap enough to keep for a year, which
is the length of the question "how did this vendor behave last spring".

### What is deliberately not here

No metrics stack — no Prometheus, no time-series database, no alerting rules. For one worker and
one interface, a table queried by a page is less to run and easier to reason about than a scrape
target. Product analytics (PostHog or similar) and an error tracker (Sentry or similar) are
separate, later additions: they answer what people do and which exceptions are thrown, which
neither of these ledgers claims to.

## Production rollout and recovery checklist

Use this for every production release. Record the release commit, operator, start/end time and a
link to the evidence. Provider dashboard configuration is not proven by files in this repository:
capture the effective Render, Vercel and PostgreSQL settings during the rollout.

For the 20 September 2026 release review, Harry is the confirmed operational alert owner; the
accepted objectives are **RPO 24 hours and RTO four hours**. A backup contact and proof of alert
delivery are still outstanding. See [current gate evidence](RELEASE-GATES.md#confirmed-operating-requirements-and-configuration--20-september-2026).

### Before release

- [ ] Name the release operator and the operational alert owner. Record a second contact for times
  when the owner is unavailable.
- [ ] Have the service owner supply the required recovery point objective (**RPO**) and recovery
  time objective (**RTO**). Do not invent them from the provider plan.
- [ ] In Render, confirm the worker plan, region, `/healthz` path, database link, auto-deploy setting,
  build filter, empty Docker Command, `WORKER_CONCURRENCY=3`, `CV_CONCURRENCY=8`, timezone and required secrets
  (`SCRAPER_CONTACT_EMAIL` above all: without a real address the new worker will not start). The
  live services are not linked to `render.yaml`, so compare them with it by hand and resolve any
  drift deliberately.
- [ ] In Vercel, confirm the production branch, region, root directory, database URL, session secret,
  application URL and any Google, Resend, cron or newsletter credentials in use.
- [ ] In PostgreSQL, confirm the plan's connection limit, storage size and headroom, that storage
  autoscaling is on (see [The database disk](#the-database-disk)), backup/PITR settings,
  retention and restore destination. **These provider settings and their adequacy are unverified
  until an operator records them.**
- [ ] Review every migration since the deployed commit. State whether it is backwards-compatible
  with the previous web and worker releases. If it is not, write the roll-forward steps and the
  exact point after which application rollback is unsafe.
- [ ] Confirm CI is green for the exact commit. Take a pre-release backup or provider restore point
  consistent with the supplied RPO.

**The release that renamed the product (`4fc3ba4`)** also renamed the transaction advisory-lock keys
the worker and the interface serialise on (`christopher:ai-budget`, `christopher:daily-runs`,
`christopher:weekly-jobs`, `christopher:users` and `christopher:profiles:<account>` became
`ava:…`). A lock only excludes holders of the same key, so while an old and a new process overlap —
Render starts the new worker before it stops the old one, and old and new Vercel deployments serve
side by side for a moment — the budget check, the daily run's fan-out and finalising, and the
first-owner takeover are not serialised between them. The overlap is short (the new worker's
health check, then the old one's shutdown, about a minute), so deploy that release when it has
nothing to serialise: away from the scheduled run time, with no CV build running (Operations ›
Running tasks), and with registration closed. What remains is a window in which two model calls
could both pass an account's budget check, a bounded overspend. The same applies to any later
release that changes a lock key; keep lock keys stable otherwise. `pnpm-lock.yaml` already names
the `@ava/*` packages, so frozen installs are unaffected.

### Roll out

- [ ] Apply the reviewed migrations through the direct PostgreSQL endpoint on port 5432
  (`pnpm db:migrate`, or `pnpm cli migrate` from `apps/worker`). For the CV quiz release, verify
  that `public.cv_drafts.gap_quiz` exists before changing either application.
- [ ] Deploy the web application and verify its exact commit through the production origin. Only
  then deploy the worker. This order ensures the quiz interface exists before the worker can write
  `awaiting_evidence`. Do not infer web success from the worker release check: verify both deployed
  commit identities separately.
- [ ] Confirm `/healthz` names the intended commit, three slots, browser availability and expected AI
  configuration; confirm Operations shows a healthy worker without a restart loop.
- [ ] Sign in through the production origin and exercise the minimum journey: read roles and a
  company, enqueue one safe task, observe it leave the queue, and confirm Health/Operations records
  the result. Use a designated test account and fixture company so the action is reversible.
- [ ] Check database connections, worker heap/RSS, oldest ready task, failed/retrying tasks and
  overdue companies. Keep the release under observation through at least one representative
  background-task burst.

### Stop, roll back or roll forward

- [ ] Stop the rollout for repeated worker restarts, database connection exhaustion, rising queue age,
  authentication failure, widespread page errors, incorrect cross-account data, lost tasks or any
  scan that incorrectly closes roles.
- [ ] Prefer a roll-forward fix once the new worker has run. The quiz migration is additive, but
  application compatibility changes when the worker writes `awaiting_evidence`, an answered parent,
  a continuation draft or its task and budget records. The previous release does not understand that
  complete lifecycle, so the presence of the nullable column alone does not make old-code rollback
  safe.
- [ ] Before considering an old-code rollback, stop the worker and use the new code to prove there
  are no `awaiting_evidence` drafts, answered parents with continuation drafts, active or queued
  continuation tasks, or CV budget holds belonging to those builds. Archiving a paused parent alone
  is not sufficient: its child, task and hold state must be reconciled as one lifecycle. Preserve the
  affected Library versions and quiz answers. Redeploy the last known-good versions only after that
  validation is empty and a release owner has accepted the result; otherwise roll forward.
- [ ] If a migration is not backwards-compatible, do not put old application code against it. Apply
  the documented forward fix. Restore the database only when the release owner accepts the data loss
  bounded by the supplied RPO.
- [ ] After recovery, verify task leases/retries, budget holds, role open/closed state and account
  isolation before reopening ordinary use. Preserve incident evidence before retention cleanup.

### Backup restoration drill

- [ ] Restore a provider backup into an isolated database; never test restoration over production.
- [ ] Record the backup timestamp, achieved RPO, restore start/end time and achieved RTO.
- [ ] Point an isolated web/worker pair at the restored database, apply only the migration plan being
  tested, and run authenticated reads plus one reversible queue journey.
- [ ] Check representative row counts and relationships for accounts, subscriptions, jobs,
  `user_jobs`, decisions, CV libraries/drafts, applications and queued/running tasks.
- [ ] Destroy the isolated copy according to the provider's data-handling process after evidence is
  retained. **No completed recovery drill is evidenced in this repository yet.**

### Alert ownership

There is no external alerting stack in this repository. Before unattended production use, the named
owner must either configure provider/external alerts or adopt a staffed inspection schedule. At a
minimum, cover: worker stopped for over two minutes, two or more crash recoveries in an hour, heap at
or above 85%, oldest ready task beyond its service target, overdue daily scans, failed tasks,
database storage above 70% or connections near the provider limit, and unexpected AI spend. Record
the delivery channel, primary/backup owner, acknowledgement target and escalation action for each
signal. An Admin › Operations page that nobody is assigned to inspect is evidence, not an alert.

## When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| Every page 500s right after deploy | Migrations have not run | `DATABASE_URL='<external url>' pnpm db:migrate` |
| Sign-in page says it needs setting up | `SESSION_SECRET` is unset | Set it in Vercel and redeploy |
| Nobody else can sign up | Registration is closed by default | Open it in Admin, or add their address to `ADMIN_EMAILS` |
| The administrator sees none of the old data | The address used is not in `ADMIN_EMAILS`, or the confirmation link was never completed | Sign up with the listed address and complete the link with your password, or sign in with Google using it |
| Confirmation or reset emails never arrive | Resend is not configured | Set `RESEND_API_KEY`, `EMAIL_FROM` and `APP_URL`; until then the links appear in the function log, and an administrator can mint reset links from Admin |
| Worker restarts repeatedly | `DATABASE_URL` wrong, or the internal URL used from another region | Use the external URL |
| Worker restarts every few minutes and nothing finishes | Out of memory: too many concurrent scans for the instance, or one very large listing | Operations › Background worker, then the runbook below |
| A company shows no source | Discovery could not find one | Open the company and paste the careers or board URL |
| A source says "blocked" | Bot protection | Paste the underlying board URL; the tool does not try to evade protection |
| Cron returns 503 | `CRON_SECRET` is unset | Set it, or ignore it in shape A |
| Worker exits with `DATABASE_URL is required` | The database is not linked | Add `DATABASE_URL` to the service, picking the database's internal connection string |
| Worker exits with `SCRAPER_CONTACT_EMAIL must be a real address` | It is unset, or still a placeholder such as `you@example.com` | Set it to an address you read and redeploy |
| A CLI command refuses with `The database is behind this checkout` or `migrated by a newer release` | The checkout is not the deployed commit | Check out the deployed commit, or, if this checkout is the release being rolled out, run `pnpm cli migrate` at the migration step |
| `pnpm seed:demo` refuses a database | It truncates every account, so it only runs against a local database | Point `DATABASE_URL` at a local database, or set `SEED_DEMO_DATABASE` to the target's exact name if you really mean to wipe it |
| Pushing to the branch does not deploy | Render is not connected to the GitHub account, so there is no webhook | Connect GitHub in Render, or trigger the deploy by hand |
| Worker cannot reach the database over TLS | The internal endpoint negotiated differently than expected | Set `DATABASE_SSL=disable` for an internal URL, or `require` for an external one |

### When a build or scan hangs

A CV that has said "generating" for an hour, or a daily run that never finishes, is almost always
one thing: the worker process is dying and being replaced, not working slowly. Read it in this
order, from **Admin › Operations**.

1. **Worker status**, at the top of the Background worker card. `healthy` means the worker
   answered within the last two minutes and has recovered from fewer than two crashes in the last
   hour. `restarting` means it is answering but has recovered from two or more — the heartbeat is
   rewritten on every boot, so a fresh report proves a fresh process, not a healthy one. `stopped`
   means nothing has reported for over two minutes.
2. **The crash count** for the last 24 hours, on the line below. A number in the dozens is a loop.
3. **The heap reading**: "184 of 258 MB heap, 71%". The ceiling is V8's, set from the memory the
   instance has — about 258 MB on a 512 MB Render Starter that also carries Chromium. When the
   heap reaches it, V8 aborts the process. Nothing catches that: no handler runs, no error is
   written, and the task that was running is simply still marked running. Above 85% the line turns
   amber, because the next large input is likely to be the last thing the process does.
4. **Last crash recovery** names the tasks the dead process was holding, with the likeliest first
   — the one with the most attempts, because a crash is not a failure and never counts as one, so
   the task that keeps killing the worker is the task with the impossible attempt count.
5. **Running tasks** shows elapsed time against each type's deadline; **Retrying tasks** shows what
   a crash handed back, with the error it left. A long retry list all naming one company or one CV
   is the cause, not the symptom.
6. **Largest scan inputs** lists the biggest listing each source returned in the last week. A
   scan holds its input in memory while it extracts from it, so compare the top of that list with
   the heap ceiling above. A board in the tens of megabytes will not fit beside two other slots.

The fix for a memory loop is fewer concurrent inputs or a larger instance, in that order:
`WORKER_CONCURRENCY` is a memory budget, not a CPU one. Production runs **3**. CV builds do not
share it: they run in `CV_CONCURRENCY` slots of their own (**8**), because a build's memory is one
Library, one CV and a PDF render rather than a fetched listing. If a crash's likely task is a
`generate_cv`, lower `CV_CONCURRENCY` before touching the general slots. `render.yaml` is a
template for creating services, not a description of the live ones — **the Render dashboard is the
source of truth** for the running worker, whose health check path and environment were set there.
Change the value in the dashboard, and in `render.yaml` so a rebuilt service inherits it.

`NODE_OPTIONS` is deliberately unset. Raising `--max-old-space-size` above what the instance has
only moves the failure from a V8 abort to the kernel's OOM killer, which is less visible, and
lowering it makes the process die sooner. The size of the input and the number of slots are the
two levers.

**The worker runs its TypeScript through `tsx`, and that costs memory.** Measured with Node 22, the
loader roughly doubles a trivial module's resident size (about 89 MB against 43 MB for the same file
as plain JavaScript) and keeps an `esbuild` service process of about 14 MB alive beside it: some 60 MB
of the 512 MB instance before any worker code runs, all of it outside the V8 heap the Operations
reading shows. Compiling ahead of time (an `esbuild --bundle --packages=external` step in the
Dockerfile, including the lazily imported browser and document-text modules, and `node dist/index.mjs`
as the command) would return most of it and skip the transpile on every boot and crash restart. It
has not been done because it is a second build of the worker to keep correct: the tests, the CLI
and the drills run from source through `tsx`, so the compiled image would be the one artefact they
never exercise, and a dynamic import the bundler misses fails only in production. It is the first
lever to reach for, before a larger instance, if the unclean exits recorded in
`docs/HOSTED-CAPACITY-2026-09-20.md` recur with the heap well under its ceiling. The `worker-image`
CI job would then boot the compiled entry point on every pull request.

A CV build has its own view of the same thing: while it is building, its page shows when it
started, the stage it reached, how long since it last advanced and which attempt it is on, and
says plainly when it has stopped rather than turning a wheel indefinitely.

### Captured logos, roles added by URL and name suggestions (migration 0029)

Migration 0029 adds `company_logos`, the logo retry columns on `companies`, `jobs.origin` /
`jobs.added_by` and `company_name_suggestions`. Apply it before deploying the web app and worker;
the interface tolerates running ahead of it in the usual way — a company with no captured logo
simply falls back to the browser's icon chain.

Existing companies have no stored logo on the day the migration lands. They are captured by the
worker's daily sweep, which takes **up to 200 companies a day**, oldest attempt first, so a
deployment of a few hundred companies is fully captured within a day or two and a large one within
a week. Anything urgent is captured on demand: **Refresh logo** in Catalogue diagnostics on the
company page queues that one company immediately. A site that refuses is retried with a widening
backoff rather than every day, and a stored logo is re-captured after 90 days.

Nothing else needs doing. Roles added by URL and name suggestions are ordinary rows created by
people using the interface; no backfill applies to them.

### External company discovery and emailed newsletters

Apply the database migrations before deploying the web app and worker. Suggestions now has a
Discovery sources section for websites, LinkedIn posts/newsletters and email newsletters. Each
source defaults to a check every seven days; change the interval (1–90 days), pause it, or use
Check now. Checks require company suggestions enabled, a running worker/scheduler and available
AI budget. Source content is untrusted input. A supporting quote, relevance assessment and live
homepage/careers verification are required before a pending recommendation is shown. Acceptance
is always manual. Already tracked or previously suggested domains are suppressed.

Website checks read the supplied page and up to ten linked articles (one level, common article
paths on the same site). Use individual article URLs for sites with other URL structures. A page
that serves a JavaScript shell over plain HTTP is rendered with the headless browser, at most five
renders per check, and only after a fetch robots.txt already allowed.

LinkedIn sources are never fetched: LinkedIn disallows automated reading on every path, so each
edition must be pasted in using Import newsletter or post text. Where a newsletter also publishes
on Substack, beehiiv or its own site, add that address as a Website source instead and it is
collected automatically. A website whose site refuses every automated reader is reported as import
only and keeps its normal cadence rather than retrying daily. No LinkedIn credentials or private
mailbox access are used.
Up to twelve unread documents are evaluated per check; a remaining backlog or a fetch error is
checked again the next day. Duplicate content is not reprocessed. Each document is limited to the
first 40,000 readable characters for fetched pages. Manual and inbound email imports accept up to 40,000 characters and reject longer editions; split them into separate imports.

For automatic email delivery:

1. Set a long random `NEWSLETTER_INGEST_SECRET` on the web deployment.
2. Optionally set `NEWSLETTER_INBOUND_DOMAIN` to a domain whose mail you route to this app (for
   example `inbox.example.com`). Every LinkedIn and email source then displays its own delivery
   address in Discover companies → Sources, derived from the source id and the ingest secret. Use
   that address to subscribe to the newsletter and each edition arrives on its own. This is the
   only automatic route into a LinkedIn newsletter, whose pages disallow automated reading.
3. Configure your email provider or forwarding automation to POST JSON to `/api/newsletters` with
   `Authorization: Bearer <NEWSLETTER_INGEST_SECRET>`. Either identify the source directly with
   `sourceId`, or pass the recipient as `to` and let the address resolve it. The subject may be
   `title` or `subject`, and the body `content`, `text` or `html`. This is a provider-neutral
   endpoint; configure a provider adapter if its webhook uses a different payload or
   authentication format.
4. The endpoint returns 202 for both a saved edition and a duplicate. Content waits for the next
   scheduled check, or select Check now. Paused sources can receive editions but do not process them.

The app does not run a mail server or subscribe to anything on your behalf: it derives the address, and your mail provider delivers to it.
