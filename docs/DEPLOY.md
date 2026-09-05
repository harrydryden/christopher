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

4. Generate the two secrets the interface needs:

   ```bash
   openssl rand -hex 32                                        # SESSION_SECRET
   pnpm --filter @christopher/web hash-password 'your password' # APP_PASSWORD_HASH
   ```

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
| `WORKER_CONCURRENCY` | `3` |

The worker runs migrations on boot, so a redeploy is always safe. Check `/healthz` returns
`{"ok":true,…}` and the logs show `worker starting`.

### The interface

In Vercel, **Add New → Project**, import the repository, then set **Root Directory** to `apps/web`.
Leave the build and install commands alone: Vercel detects the pnpm workspace and installs from the
repository root.

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **External** database URL |
| `SESSION_SECRET` | from above |
| `APP_PASSWORD_HASH` | from above |

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
| `TZ` | e.g. `Europe/London` |

`apps/web/vercel.json` already declares the schedule (`0 6 * * *`). Change the time there if you
want; on Hobby, Vercel runs cron jobs approximately, not to the minute.

On a paid plan, raise `maxDuration` in `apps/web/app/api/cron/route.ts` from 60 to 300 so a whole
run finishes in one invocation.

### Living without a worker

- **The queue only moves when the route is called.** Buttons in the interface that say "run now"
  add work to the queue; nothing processes it until the next cron. To run it immediately, visit
  `https://<your app>/api/cron` while signed in. A session is accepted as well as the bearer token.
- **A run that hits the time limit stops cleanly** and reports `timedOut: true`. Whatever is left
  stays queued for the next call, so nothing is lost, but on Hobby that means tomorrow.
- **JavaScript careers pages will not resolve.** They appear on Health as needing attention. Open
  the company, paste the underlying board URL (the `boards.greenhouse.io/...` or
  `jobs.lever.co/...` address), and it is scanned normally from then on.

Moving to shape A later is only a Render deploy: add the worker service, unset
`CHRISTOPHER_DISABLE_BROWSER`, and the same database keeps every company, role and decision.

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

## Costs

| | |
|---|---|
| Render Postgres, smallest paid instance | ~$7/month |
| Render worker, Starter (shape A only) | ~$7/month |
| Vercel Hobby | $0 |
| Anthropic API, 30 companies in steady state | ~$3–10/month |

The Health page tracks month-to-date model spend against the budget you set in Settings, and stops
optional model calls when it is exceeded.

## When something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| Every page 500s right after deploy | Migrations have not run | `DATABASE_URL='<external url>' pnpm db:migrate` |
| Sign-in page says it needs setting up | `APP_PASSWORD_HASH` is unset | Set it in Vercel and redeploy |
| Worker restarts repeatedly | `DATABASE_URL` wrong, or the internal URL used from another region | Use the external URL |
| A company shows no source | Discovery could not find one | Open the company and paste the careers or board URL |
| A source says "blocked" | Bot protection | Paste the underlying board URL; the tool does not try to evade protection |
| Cron returns 503 | `CRON_SECRET` is unset | Set it, or ignore it in shape A |
| Worker exits with `DATABASE_URL is required` | The database is not linked | Add `DATABASE_URL` to the service, picking the database's internal connection string |
| Pushing to the branch does not deploy | Render is not connected to the GitHub account, so there is no webhook | Connect GitHub in Render, or trigger the deploy by hand |
| Worker cannot reach the database over TLS | The internal endpoint negotiated differently than expected | Set `DATABASE_SSL=disable` for an internal URL, or `require` for an external one |
