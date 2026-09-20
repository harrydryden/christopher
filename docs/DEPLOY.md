# Deploying Christopher

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

1. In Render, **New → Postgres**. Any paid instance is fine; the free tier expires after 30 days.
   Note the region, and put the interface in a nearby Vercel region later.
2. Copy the **External Database URL**. It already carries `?sslmode=require`.
3. Create the tables from your own machine:

   ```bash
   git clone https://github.com/harrydryden/christopher && cd christopher
   pnpm install
   DATABASE_URL='<external database url>' pnpm db:migrate
   ```

   Migrations are safe to re-run; they take an advisory lock, so nothing is damaged if the worker
   starts at the same moment.

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

---

## Shape A · Vercel + Render worker

### The worker

Render can read `render.yaml` from the repository: **New → Blueprint**, point it at the repo, and it
creates the worker service (it will also offer to create a database; skip that if you made one
above). Or create it by hand: **New → Web Service**, runtime **Docker**, Dockerfile path
`Dockerfile`, Docker context `.`, health check path `/healthz`, instance type
**Starter** (the free type sleeps, which stops the scheduler).

### Linking the database

`DATABASE_URL` is the one value that cannot be set through the API, because Render never exposes a
database password over it. In the dashboard, open the worker service, go to **Environment**, add a
variable named `DATABASE_URL`, and use the database picker in the value field to select
**christopher-db → Internal Connection String**. Saving triggers a redeploy.

Until it is set, the worker builds and starts but exits with `DATABASE_URL is required`.

Set these on the service:

| Variable | Value |
|---|---|
| `DATABASE_URL` | linked from the database as above; use the **Internal** string when the service and database share a region |
| `ANTHROPIC_API_KEY` | your key. Without it, scanning still works and scoring is skipped |
| `SCRAPER_CONTACT_EMAIL` | an address you read; it goes in the user agent |
| `TZ` | e.g. `Europe/London` |
| `WORKER_CONCURRENCY` | `3` — the supported value for the 512 MB Starter instance shared with Chromium. It gives a database pool of `2 × concurrency + 4` = 10 connections. Six slots caused an observed ten-hour out-of-memory restart loop on a 41 MB listing; use six only after increasing the instance size and proving memory and database headroom under a representative soak |

The worker and migration runner must use Render’s **direct port 5432** database URL: the session advisory migration lock is incompatible with transaction pooling. The migration runner rejects known Render pooled URLs on port 6432 before connecting. Vercel request-serving functions can use the **pooled port 6432** URL; enabling PgBouncer alone does not switch existing clients. See [Render’s connection-pooling documentation](https://render.com/docs/postgresql-connection-pooling).

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
| `DATABASE_URL` | the **External** database URL |
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
anyway. Set it if you want the cron as a safety net; duplicate runs are deduplicated per day.

---

## Shape B · Vercel only

Deploy the interface exactly as above, and add:

| Variable | Value |
|---|---|
| `CRON_SECRET` | `openssl rand -hex 32`. Vercel sends it as `Authorization: Bearer …` on every cron call |
| `ANTHROPIC_API_KEY` | your key |
| `SCRAPER_CONTACT_EMAIL` | an address you read |
| `CHRISTOPHER_DISABLE_BROWSER` | `1`. There is no Chromium in the Vercel runtime |
| `CHRISTOPHER_SERVERLESS_FALLBACK` | `1`. Without it the route only queues work; with it the route also runs the queue itself (see below) |
| `TZ` | e.g. `Europe/London` |

`apps/web/vercel.json` already declares the schedule (`0 6 * * *`). Change the time there if you
want; on Hobby, Vercel runs cron jobs approximately, not to the minute.

On a paid plan, raise `maxDuration` in `apps/web/app/api/cron/route.ts` from 60 to 300 so a whole
run finishes in one invocation.

### Living without a worker

- **`CHRISTOPHER_SERVERLESS_FALLBACK=1` is what makes the route do the work.** Without it the cron
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
`CHRISTOPHER_DISABLE_BROWSER` and `CHRISTOPHER_SERVERLESS_FALLBACK`, and the same database keeps
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

## Continuous integration

Two workflows. **CI** (`.github/workflows/ci.yml`) runs on every pull request and again on
every push to `main`; **Release** (`.github/workflows/release.yml`) runs only after CI has
passed on `main`.

CI is two jobs side by side, each on its own runner with its own throwaway PostgreSQL 16:

| Job | What it runs | Typical |
|---|---|---|
| `check` | `pnpm -r typecheck`, then `pnpm -r test` | ~2.5 min |
| `browser-and-smoke` | Chromium install, the headless browser test, `pnpm db:migrate`, `pnpm smoke:web` (a production `next build`, sign-in, every page, and the CV workspace driven through Playwright) | ~2.5 min |

So a pull request is green in about two and a half minutes of wall clock for about five
billed minutes. A pull request is checked once, on its merge result: pushing to a branch no
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
`/healthz` — up to eight minutes — until it reports the merged commit, and fails if it never
does. That is the only check that a *worker* deployment happened: Vercel deploying the
interface says nothing about CV generation or scanning, which the worker alone does. It is
deliberately not on pull requests, where nothing has been deployed and there is nothing to
verify; before, it appeared there as a skipped job, which reads like a problem. It runs from
the `Release` workflow on the commit CI passed on, named explicitly through `RELEASE_SHA`
because a `workflow_run` job's own `GITHUB_SHA` is the branch tip rather than that commit.

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
  `WORKER_CONCURRENCY=3`, timezone and required secrets. Compare them with `render.yaml`; resolve any
  drift deliberately.
- [ ] In Vercel, confirm the production branch, region, root directory, database URL, session secret,
  application URL and any Google, Resend, cron or newsletter credentials in use.
- [ ] In PostgreSQL, confirm the plan's connection limit, storage headroom, backup/PITR settings,
  retention and restore destination. **These provider settings and their adequacy are unverified
  until an operator records them.**
- [ ] Review every migration since the deployed commit. State whether it is backwards-compatible
  with the previous web and worker releases. If it is not, write the roll-forward steps and the
  exact point after which application rollback is unsafe.
- [ ] Confirm CI is green for the exact commit. Take a pre-release backup or provider restore point
  consistent with the supplied RPO.

### Roll out

- [ ] Apply the reviewed migrations through the direct PostgreSQL endpoint on port 5432. For the CV
  quiz release, verify that `public.cv_drafts.gap_quiz` exists before changing either application.
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
database storage/connections near the provider limit, and unexpected AI spend. Record the delivery
channel, primary/backup owner, acknowledgement target and escalation action for each signal. An
Admin › Operations page that nobody is assigned to inspect is evidence, not an alert.

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
`WORKER_CONCURRENCY` is a memory budget, not a CPU one. Production runs **3**. `render.yaml` is a
template for creating services, not a description of the live ones — **the Render dashboard is the
source of truth** for the running worker, whose health check path and environment were set there.
Change the value in the dashboard, and in `render.yaml` so a rebuilt service inherits it.

`NODE_OPTIONS` is deliberately unset. Raising `--max-old-space-size` above what the instance has
only moves the failure from a V8 abort to the kernel's OOM killer, which is less visible, and
lowering it makes the process die sooner. The size of the input and the number of slots are the
two levers.

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
paths; LinkedIn pulse/posts links). Use individual article URLs for sites with other URL structures.
Pages that require sign-in or block fetching are reported on the source. Paste their readable text
using Import newsletter or post text. No LinkedIn credentials or private mailbox access are used.
Up to twelve unread documents are evaluated per check; a remaining backlog or a fetch error is
checked again the next day. Duplicate content is not reprocessed. Each document is limited to the
first 40,000 readable characters for fetched pages. Manual and inbound email imports accept up to 40,000 characters and reject longer editions; split them into separate imports.

For automatic email delivery:

1. Create an Emailed newsletter source in Suggestions and copy its displayed source ID.
2. Set a long random `NEWSLETTER_INGEST_SECRET` on the web deployment.
3. Configure your email provider or forwarding automation to POST JSON to `/api/newsletters`,
   with `Authorization: Bearer <NEWSLETTER_INGEST_SECRET>` and the fields `sourceId`, `title`
   (email subject) and `content` (plain text or HTML body). This is a provider-neutral endpoint;
   configure a provider adapter if its webhook uses a different payload or authentication format.
4. The endpoint returns 202 for both a saved edition and a duplicate. Content waits for the next
   scheduled check, or select Check now. Paused sources can receive editions but do not process them.

The app does not create a receiving email address or automatically subscribe to newsletters.
