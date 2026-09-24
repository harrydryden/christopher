# Deploying the 24 September 2026 release

A step-by-step guide for one person deploying `main` at
`40731b62ef8f3fb0f0a98988414a6df2e8f292dc` (pull request #76, on top of #75) to the production
deployment: the interface on Vercel, the worker on Render, and the PostgreSQL database on Render.

It draws on [AUDIT-2026-09-23.md](AUDIT-2026-09-23.md) ("Deploy notes" and "Deliberately
deferred"), [DEPLOY.md](DEPLOY.md), [RELEASE-GATES.md](RELEASE-GATES.md), `render.yaml`,
`.env.example`, [packages/db/README.md](../packages/db/README.md) and the code. Where those say
nothing, the step says so. Where they disagree, the step follows the code and says so.

The live services are named `christopher-worker` and `christopher-db` in Render, not the `ava-*`
names in `render.yaml`. They are not linked to the blueprint, so **the dashboards are the source of
truth** and every setting below is changed there by hand.

The order is: prepare and back up, check the database, migrate, deploy the interface, deploy the
worker, verify. Each step ends with how you know it worked. If a check fails, stop and go to
[Rolling back](#rolling-back).

---

## Before you start

### 1. Pick a quiet window

Do not deploy near the daily scan. Its default is 06:00 Europe/London; an administrator can change
it, so check the shared schedule on the Admin page. Scheduled scans then spread over
`SCAN_SPREAD_MINUTES` (default 60). In **Admin › Operations › Running tasks**, make sure no CV build
is running.

If production is still on a commit older than pull request #74 (the rename to AVA), this deploy also
changes the advisory-lock names. Old and new processes then do not exclude each other while they
overlap. DEPLOY.md asks you to close registration in Admin for that release as well.

**You know it worked when** the scan time is well clear of now, Running tasks shows no CV build,
and (if needed) registration is closed.

### 2. Confirm CI is green for this commit

In GitHub, open the **CI** workflow run for `40731b6` on `main`. The `check`, `browser-and-smoke` and
`worker-image` jobs must all have passed.

**You know it worked when** all three jobs show green for `40731b62ef8f…`.

### 3. Record what is running now

Run these and write down both commits. They are what you roll back to.

```bash
curl -s https://christopher-web-kappa.vercel.app/api/health
curl -s https://christopher-worker.onrender.com/healthz
```

These are the URLs recorded in RELEASE-GATES.md on 20 September. Use your own if they have changed.

Both Vercel and Render may auto-deploy `main`. If they do, the merge of #76 may already be
deploying. If the worker already reports `40731b6…`, it has already run the migrations at boot.
Go to step 10 for the variables, then carry on from step 13. The repository does not say whether
auto-deploy is on for the live services (DEPLOY.md only asks you to confirm it). You find it in each
dashboard's build and deploy settings.

**You know it worked when** you have both commit hashes written down, and you know whether either
platform has already started deploying the new commit.

### 4. Back up

- **Database.** Render's database dashboard showed a three-day point-in-time recovery window on
  20 September. Confirm it is still there, and write down the current UTC time as your restore
  point. The agreed recovery point objective is 24 hours. The repository does not describe taking a
  separate manual backup or export.
- **Settings.** Screenshot or copy every environment variable on the Render worker and on the
  Vercel project, plus the Render service settings (plan, region, health check path, build filter,
  Docker Command). DEPLOY.md asks for these to be captured on every release.
- **Deployments.** The commits from step 3 identify the Vercel deployment and the Render deploy to
  go back to.

**You know it worked when** you have a restore time inside the recovery window, a copy of both
platforms' settings, and the two known-good commits.

### 5. Prepare a checkout on your machine

```bash
git clone https://github.com/harrydryden/christopher && cd christopher
git checkout 40731b62ef8f3fb0f0a98988414a6df2e8f292dc
pnpm install
```

You also need `psql` and the database's **External Database URL** (the direct one, port 5432) from
the Render database page.

**You know it worked when** `git rev-parse HEAD` prints `40731b62ef8f…` and `pnpm install` finishes
without errors.

---

## The database

### 6. Check the migration journal against production (read-only)

This release ships two new migrations: `0037_scan_closure_evidence` and `0038_ai_calls_cv_ref_index`.
There is deliberately no `0035`. The migration runner now refuses to finish when any journal entry
is missing from `drizzle.__drizzle_migrations`, including one numbered *before* a migration that is
already applied. The migrator would silently skip such an entry, so the runner treats it as a
historical gap. A gap stops the worker at boot.

Connect with `psql '<external database url>'` and run:

```sql
set default_transaction_read_only = on;

with journal(tag, "when") as (values
  ('0000_great_hitman', 1788565261775), ('0001_many_sentinels', 1788627836984),
  ('0002_married_lilith', 1788629959679), ('0003_furry_nighthawk', 1788679864068),
  ('0004_young_captain_flint', 1788721547578), ('0005_massive_frank_castle', 1788788247871),
  ('0006_large_ultron', 1788966883730), ('0007_low_albert_cleary', 1789122461461),
  ('0008_material_aaron_stack', 1789128762993), ('0009_motionless_roughhouse', 1789129024594),
  ('0010_hesitant_fallen_one', 1789129124809), ('0011_orange_dagger', 1789129604169),
  ('0012_flashy_the_fury', 1789129691269), ('0013_role_workflow', 1789146000000),
  ('0014_loving_umar', 1789242528851), ('0015_steady_shockwave', 1789243664418),
  ('0016_cv_build_progress', 1789282777415), ('0017_cv_retention', 1789315267189),
  ('0018_cv_role_lookup', 1789320656714), ('0019_cv_daily_versions', 1789374796368),
  ('0020_multi_user', 1789554417069), ('0021_account_ai_budgets', 1789657520896),
  ('0022_account_ai_reservations', 1789726500000), ('0023_settings_hygiene', 1789812000000),
  ('0024_worker_runtime', 1789898400000), ('0025_worker_observability', 1789984800000),
  ('0026_traffic_and_stages', 1790071200000), ('0027_cv_build_steps', 1790157600000),
  ('0028_cv_build_fences', 1790244000000), ('0029_company_logos_and_user_postings', 1790330400000),
  ('0030_application_lifecycle', 1790416800000), ('0031_wave2_evidence_and_states', 1790503200000),
  ('0032_library_imports', 1790589600000), ('0033_cv_shares', 1790676000000),
  ('0034_cv_gap_quiz', 1790762400000), ('0036_indexes_and_retention', 1790935200000),
  ('0037_scan_closure_evidence', 1791021600000), ('0038_ai_calls_cv_ref_index', 1791108000000)),
applied as (select created_at::bigint as "when" from drizzle.__drizzle_migrations),
newest as (select max("when") as at from applied)
select j.tag,
       case when j."when" <= n.at then 'GAP - the guard will refuse' else 'pending - will be applied' end as state
from journal j cross join newest n
where j."when" not in (select "when" from applied)
order by j."when";

-- The newest migration production has applied.
select max(created_at)::bigint as newest from drizzle.__drizzle_migrations;
```

The values are the `when` fields from `packages/db/drizzle/meta/_journal.json`. The migrator stores
each one as `created_at`, and the guard compares on it, not on the hash.

- The audit says production already has `0036`. In that case the first query returns exactly two
  rows, `0037` and `0038`, both "pending".
- If production is older, `0034` and `0036` may also show as pending. That is fine, provided every
  row says "pending".
- **Any row that says "GAP"** means this release cannot boot against production. Stop here. The fix
  is a code change: give that migration a later `when` (packages/db/README.md). You cannot fix it
  from the dashboard.
- The second query must return one of the journal's values, no later than `1791108000000`. A later
  value means production was migrated by a newer release than this one.

**You know it worked when** every missing migration is "pending", none is "GAP", and the newest
applied value is one the journal lists.

### 7. Optional: build 0038's index by hand first

`0038` runs a plain `CREATE INDEX` on `ai_calls`, which blocks writes to that table while it builds.
The migration file asks you to build the index by hand with `CONCURRENTLY` first if the table is
"large enough for the build to matter". No row count is given as the threshold. Check the size with
`select count(*) from ai_calls;`. If you decide to build it by hand, run these in a session that is
*not* read-only:

```sql
set statement_timeout = 0;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_calls_cv_ref_at_idx" ON "ai_calls" USING btree ("ref_id", "at")
  WHERE "ref_type" like 'cv-%' AND "ref_id" IS NOT NULL;
```

The migration's `IF NOT EXISTS` then skips it. `0037` adds columns and runs backfill updates on
`jobs` and `user_jobs`. It is idempotent, and there is no by-hand variant for it.

**You know it worked when** `\d ai_calls` lists `ai_calls_cv_ref_at_idx` and does not mark it
`INVALID`.

### 8. Set the role's time limits

PgBouncer refuses the timeout settings that the worker and scripts send when they connect, so the
interface's pooled connections would otherwise have none. Set them once on the database role. The
role is the user name in the connection string.

```sql
ALTER ROLE <database user> SET statement_timeout = '30s';
ALTER ROLE <database user> SET idle_in_transaction_session_timeout = '60s';
```

Direct connections (the worker, migrations) override these with their own values. Every new `psql`
session now inherits 30 seconds, so run `SET statement_timeout = 0` first for anything long.

**You know it worked when**
`select rolconfig from pg_roles where rolname = current_user;` (in a new session) shows
`statement_timeout=30s` and `idle_in_transaction_session_timeout=60s`.

### 9. Apply the migrations

From the checkout, using the **direct External URL on port 5432**:

```bash
DATABASE_URL='<external database url>' pnpm db:migrate
```

The runner refuses a pooled URL on port 6432. It takes an advisory lock, gives up on any table lock
after ten seconds and retries up to six times, and refuses to finish if any journal entry is left
unapplied. If the worker boots at the same moment, nothing is damaged.

**You know it worked when** the command exits without an error, and the first query in step 6 now
returns no rows. As a second check, `cd apps/worker && DATABASE_URL='<external url>' pnpm cli users`
runs instead of refusing with "The database is behind this checkout".

---

## Environment variables

### 10. What this release adds or changes, and where each one goes

Set these now, **but do not save the Render worker's variables until step 12**. Saving variables on
Render triggers a redeploy, and the worker must go after the interface.

| Variable | Where | What to set | Why it is in this release |
|---|---|---|---|
| `DATABASE_URL` | Vercel | Render's **pooled** External URL, **port 6432** | About 30 warm interface instances on the direct URL exhaust the database. The worker keeps the **direct Internal** URL (5432). The migration runner refuses 6432. |
| `SESSION_SECRET` | Vercel | at least 32 random characters: `openssl rand -hex 32` | In production a shorter value, or the `.env.example` placeholder, now counts as unset and nobody can sign in. A new value probably signs everyone out (the cookie signature changes); the documents do not say so explicitly. |
| `SCRAPER_CONTACT_EMAIL` | Render; also Vercel **if `CRON_SECRET` is set** | an address you read | A production worker now refuses to start without one, or with a placeholder domain such as `example.com`, `.test` or `.invalid`. The cron fallback runs the same code. |
| `WORKER_STATUS_TOKEN` | Render, **and** GitHub secret `WORKER_STATUS_TOKEN` | the same long random string in both places. The repository says "a long random string" and does not name a generator. | `/healthz` is now liveness only. The full figures are served at `/status`, behind this token. |
| `WORKER_STATUS_URL` | GitHub repository variable | `https://christopher-worker.onrender.com/status` | RELEASE-GATES.md calls this optional, but it is not optional for this release: unset, the operational check reads `/healthz`, which no longer carries the figures, and fails with incomplete telemetry. |
| `ADMIN_EMAILS` | Vercel **and** Render, the same list | comma-separated administrator addresses | When unset, the built-in default `harryddryden@gmail.com` applies. Both the interface and the worker now log a warning at start-up when it is unset. The administrator role goes only to a listed address that has been proven; it is never granted at registration. |
| `AUTH_EMAIL_LOG` | Vercel | leave unset (recommended), or `1` | In production, confirmation and reset links are no longer written to the function log unless this is `1`, because a reset link in the log is an account takeover. Without Resend, mint reset links from **Admin › Accounts** instead. DEPLOY.md's "Without Resend" paragraph still describes the old behaviour. |
| `APP_URL` | Vercel | `https://<your vercel host>` | In production, emailed links are not built without it when Resend is configured (the log shows `email_origin_missing`). |
| `WORKER_CONCURRENCY` | Render | `3` | The supported value for the 512 MB Starter instance. Confirm it has not drifted. |

**Renamed variables.** The old `CHRISTOPHER_*` name is still read wherever the new name is unset,
so nothing breaks on deploy. Rename them when convenient.

| New name | Old name | Where |
|---|---|---|
| `AVA_DISABLE_BROWSER` | `CHRISTOPHER_DISABLE_BROWSER` | The worker must **not** set it (it needs Chromium). Vercel only in shape B. |
| `AVA_SERVERLESS_FALLBACK` | `CHRISTOPHER_SERVERLESS_FALLBACK` | Vercel, shape B only. Leave it unset beside the Render worker. |
| `AVA_CLI_USER` | `CHRISTOPHER_CLI_USER` | Your own shell, when you run `pnpm cli` |
| `AVA_HOST_MAP` | `CHRISTOPHER_HOST_MAP` | Tests only. Never set it in production. |
| `AVA_SCRYPT_N` | `CHRISTOPHER_SCRYPT_N` | Tests only. Ignored in production. |

**You know it worked when** every row above has a value (or a deliberate "unset") in the right place,
and nothing on the worker is still named `CHRISTOPHER_*`.

---

## Deploying

The order is: migrations (done), then the interface, then the worker (DEPLOY.md, "Roll out").

### 11. Deploy the interface on Vercel

In the Vercel project, save the variables from step 10. Then deploy `40731b6` to production. If
auto-deploy has already built it, redeploy it, because variable changes take effect only on a new
deployment. The repository does not describe the Vercel dashboard buttons.

**You know it worked when** `curl -s https://christopher-web-kappa.vercel.app/api/health` returns
`{"ok":true,"commit":"40731b62ef8f3fb0f0a98988414a6df2e8f292dc"}`. You should also be able to sign in
through the production address, and Vercel's function logs should show no `session_secret_refused`
and no `database_direct_endpoint`.

### 12. Deploy the worker on Render

On the worker service, open **Settings → Build & Deploy** and confirm three things:

- **Docker Command** is **empty**, so the image's `tini` entrypoint runs Node as the unprivileged
  `pwuser`.
- **Build Filters** list exactly `render.yaml`'s paths.
- The health check path is `/healthz`.

Then open **Environment**, save the worker variables from step 10 (this starts a redeploy), and make
sure the deploy is for `40731b6`. The worker migrates at boot, which is a no-op after step 9.

The old and new workers overlap for about a minute. Dedupe keys and existing-run checks prevent
duplicate scheduling.

**You know it worked when** the deploy log shows a `worker environment` line (slots 3, the pool
ceiling, the heap limit, `browser: true`) followed by `worker starting`, and
`curl -s https://christopher-worker.onrender.com/healthz` returns `ok: true` with the new commit. If
it exits with `SCRAPER_CONTACT_EMAIL must be a real address`, the variable is missing or a
placeholder.

Note: DEPLOY.md's rollout checklist says `/healthz` names the slots, browser and AI configuration.
Since this release it returns only `ok`, `workerId` and `commit`. Those figures are now in the
`worker environment` log line and in `/status`.

---

## Verifying

### 13. The release checks

After CI passes on `main`, the **Release** workflow runs `scripts/verify-web-release.mjs` and
`scripts/verify-worker-release.mjs` on its own. Each polls for up to eight minutes for `ok: true` and
the exact commit. The worker check also accepts an ancestor with identical worker inputs. If the
workflow timed out before you deployed, re-run it from GitHub Actions, or run the checks from your
checkout (the worker check needs full git history):

```bash
RELEASE_SHA=40731b62ef8f3fb0f0a98988414a6df2e8f292dc \
WEB_HEALTH_URL=https://christopher-web-kappa.vercel.app/api/health \
node scripts/verify-web-release.mjs

RELEASE_SHA=40731b62ef8f3fb0f0a98988414a6df2e8f292dc \
WORKER_HEALTH_URL=https://christopher-worker.onrender.com/healthz \
node scripts/verify-worker-release.mjs
```

**You know it worked when** both jobs in the Release run are green, or both scripts print
"… is healthy and running merged commit …".

### 14. The operational status check

This makes three read-only requests to `/status`, 15 seconds apart. It checks for a restart loop,
heap pressure, database waits, an old or growing queue, overdue scans and discovery, and persistent
provider failures.

```bash
WORKER_HEALTH_URL=https://christopher-worker.onrender.com/healthz \
WORKER_STATUS_URL=https://christopher-worker.onrender.com/status \
WORKER_STATUS_TOKEN='<the token from step 10>' \
OPERATIONAL_EXPECTED_SHA=40731b62ef8f3fb0f0a98988414a6df2e8f292dc \
node scripts/verify-operational-status.mjs
```

Then run the **Operational status** workflow once by hand (it supports manual dispatch) to prove the
GitHub variable and secret are right. After that it runs every 15 minutes on its own.
`curl -H "Authorization: Bearer <token>" https://christopher-worker.onrender.com/status` should
return the figures, and the same request without the header should return 401.

**You know it worked when** the script exits 0 and the manual workflow run is green. "Attention"
lines (a few overdue or unscannable companies, accounts at their budget) are not failures; read them
anyway.

### 15. The minimum journey

Sign in through the production address with a designated test account. Read the roles table and one
company. Enqueue one safe task, for example Refresh logo on a fixture company, and watch it leave the
queue. Then check **Admin › Operations**: the worker should read `healthy`, with no crash
recoveries. Keep watching through at least one burst of background work.

**You know it worked when** the task completes and Operations shows a healthy worker with a steady
heap and no restarts.

---

## What to expect on the first run

### 16. Expected one-off work

- **Re-scoring.** The scoring fingerprint now covers the evidence a role can use, so each account's
  first `rescore_all` pass re-scores every role in its table once. `rescore_all` is queued by a
  profile, settings or library change, not by the deploy. Expect a one-off rise in scoring calls in
  Operations as accounts trigger it.
- **Retired-source sweep.** The first daily run closes the open roles of sources nobody scans any
  more: disabled or superseded sources, and companies nobody follows. Their `closed_at` is set to
  the time the role was last seen, and each gets a `closed` event with reason `source_retired`. This
  is the one sanctioned exception to "only a successful scan closes a role". To preview the number
  (read-only):

  ```sql
  select count(*) from jobs j join career_sources cs on cs.id = j.source_id join companies c on c.id = cs.company_id
  where j.status = 'open' and j.origin = 'scan' and (cs.status = 'disabled' or c.status = 'archived');
  ```

  The `daily run started` log line reports the actual count as `retired`.
- **Closure evidence.** A posting already missed once was stamped with the migration's time. Two
  misses now close a role only when they are at least six hours apart, so some closures happen later
  than before, never earlier.
- **Gate re-evaluation at boot.** This runs only when the stored gate version differs from the
  code's. If production had never run a worker from #75 or later, the first boot queues one
  `reevaluate_gate` task per account and logs `gate semantics changed; re-evaluating every account`.
  Otherwise it queues nothing.
- **Long scans.** Structured feeds may now make up to 600 listing requests per scan. At 250 ms per
  request that is about 150 seconds, against the 3-minute scan deadline, for a company with several
  very large boards.

**You know it worked when** the first daily run finishes, the `retired` count roughly matches your
preview, and no role closed by a scan lacks two misses six hours apart.

### 17. Optional: bump `GATE_REEVALUATION_VERSION`

It was not bumped, because the gate's decisions are unchanged. Bumping it to 2 would re-run every
account's gate once and repair views that earlier widenings left archived. The audit calls this "an
operator's call".

It is **a code constant, not an environment variable**: `GATE_REEVALUATION_VERSION` in
`packages/core/src/tasks.ts`. It needs a commit and a worker deploy. The repository does not describe
how to make that commit. `packages/core/src/gate-reevaluation-version.test.ts` requires a recorded
digest for each version and forbids two versions sharing one. Because the gate's output has not
changed, version 2 would have the same digest as version 1, and the test would fail as written. Any
bump therefore needs a deliberate change to that test, reviewed like any other change.

**You know it worked when** (if you do it) the next worker boot logs
`gate semantics changed; re-evaluating every account` with `version: 2`, and the queued
`reevaluate_gate` tasks drain.

---

## Rolling back

### 18. If something fails

**Stop the rollout** if you see any of these: repeated worker restarts, database connection
exhaustion, rising queue age, authentication failures, widespread page errors, wrong data across
accounts, lost tasks, or any scan that closes roles incorrectly.

- **Before the worker is deployed** (the interface fails in step 11): redeploy the interface commit
  from step 3 on Vercel. If the problem is the pooled URL, put the previous `DATABASE_URL` back and
  redeploy. The migrations can stay.
- **After the worker has run**: DEPLOY.md prefers a **roll-forward fix**. Old-code rollback needs a
  release owner to accept the result first.
- **Is old code safe against 0037 and 0038?** The repository does not say. Both migrations are
  additive (new columns with defaults, one index), but no document states that the previous release
  runs correctly against them. Treat a rollback as unverified.
- **To roll back anyway**: redeploy the commits recorded in step 3 (the Render worker first, so
  nothing new is written; then the Vercel interface) and restore the variables you copied in step 4.
  The repository does not document the dashboard buttons for either platform. The `ALTER ROLE`
  settings can stay: direct connections override them.
- **Restoring the database** is for data damage only, and loses data back to your restore point.
  Restore to a new database through Render's point-in-time recovery, never over production (see
  DEPLOY.md, "Backup restoration drill"). Do it only if the release owner accepts that loss.
- **After any recovery**, check task leases and retries, budget holds, open and closed roles, and
  account isolation before reopening ordinary use.

**You know it worked when** `/api/health` and `/healthz` report the commits you rolled back to, the
operational check passes against that commit, and Operations shows a healthy worker.

---

## Do not do

- Do not run `pnpm seed:demo` against production. It truncates every account. It refuses anything
  but a local database unless `SEED_DEMO_DATABASE` names the target, and you should never set that
  for production.
- Do not visit `/api/cron` in a browser. A signed-in GET is refused (405). Start a run with the
  **Run now** control on the Admin page, which sends a same-origin POST.
- Do not point the worker or `pnpm db:migrate` at the pooled 6432 URL, and do not leave the
  interface on the direct 5432 URL.
- Do not set a Docker Command on Render.
- Do not set `AVA_DISABLE_BROWSER`, `AVA_SERVERLESS_FALLBACK` or `AVA_HOST_MAP` (or their
  `CHRISTOPHER_*` names) on the Render worker.
- Do not set `NODE_OPTIONS` or raise `WORKER_CONCURRENCY` above 3 on the Starter instance.
- Do not grant the administrator role at registration, or add an address to `ADMIN_EMAILS` that you
  have not proven.
- Do not deploy the worker before the migrations and the interface.
- Do not run `pnpm cli` from a checkout that is not the deployed commit. It refuses anyway.
- Do not set `AUTH_EMAIL_LOG=1` in production unless nobody else can read the function logs.

## Deliberately deferred (do not expect these)

- The worker still runs TypeScript through `tsx`; it is not compiled ahead of time.
- There is no protection against DNS rebinding at connect time.
- cheerio's parser is still quadratic on unclosed formatting tags.
- Newsletter ingestion uses one deployment-wide token, not one per source. The limit is 50 documents
  per source per day.
- `cv_libraries` and `preference_profiles` are not pruned.
- Signup still answers "exists" for a registered address.
- The capacity benchmark covers 100 users and 20 companies with no pollers. Its new phases have not
  been run end to end, so there is no threshold for queries per second.
- The Teamtailor and SuccessFactors verification markers have not been tightened.
- There is no alerting stack. Delivery of the Operational status workflow's failures to a person has
  not been proven, and no complete recovery drill is evidenced.
