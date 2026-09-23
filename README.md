# AVA

Watches the careers pages of companies you list, once a day. Keeps a table of the roles that match
your keywords **and** your locations, tracks how long each has been live and when it closes, and
learns which roles to put in front of you from the reasons you give when you apply or skip. It also
recommends companies similar to the ones you already track.

Several people can share one deployment: each has their own account, companies, filters, learning and CVs, while every company is discovered and scanned once for everyone. Give it a homepage URL and it finds the careers page itself.

- **Functional review and remaining release gates:** [docs/REVIEW-PLAN.md](docs/REVIEW-PLAN.md)
- **Specification:** [docs/SPEC.md](docs/SPEC.md)
- **Interface:** Next.js on Vercel. **Worker and database:** Render.

---

## What it does

| | |
|---|---|
| **Add a company** | Paste a homepage URL. Discovery finds the careers source: it harvests and scores links, probes well-known paths, reads sitemaps, and fingerprints applicant tracking systems in the markup, in JavaScript bundles and in the network calls a page makes. High confidence is accepted automatically; medium confidence asks you to confirm one of three candidates. |
| **Scan daily** | One run at your chosen local time. Applicant tracking system feeds are read as JSON (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, Personio, BambooHR, Workday, Pinpoint, Breezy). Everything else falls back to JSON-LD, then to model extraction that writes a CSS selector recipe, so later scans of an unchanged page cost nothing. |
| **Filter** | Roles enter the table only if they match your include keywords, avoid your exclude keywords, and sit in one of your locations. `UK` expands to its nations and cities; a remote role passes unless it names a different region. |
| **Track change** | A role closes only after it is absent from two consecutive successful scans. A failed or suspicious scan never closes anything. Reappearing roles reopen; near-identical reposts are linked. |
| **Decide** | Apply or skip, with a reason. The reason is tagged, folded into a versioned preference profile you can read and edit, and used to score every future role out of 100. |
| **Learn** | Weekly, the model proposes keyword, location and threshold changes with the evidence behind them. Roles that just missed your keywords but score well appear in a separate section, so learning can widen your search rather than only narrow it. |
| **Recommend** | Weekly, similar companies are proposed, each verified first: the homepage resolves, a careers source is discoverable, and its open and matching roles are counted. |

## Repository layout

```
apps/web         Next.js interface (Vercel)
apps/worker      scheduler, scrapers, model calls, task queue (Render)
packages/core    discovery, ATS adapters, extraction, the gate, change detection
packages/ai      one function per model call site, schema-validated
packages/db      Drizzle schema, migrations, task queue helpers
docs/SPEC.md     the specification this implements
```

`packages/core` holds every decision that affects accuracy and is pure: fetchers are injected, so
all of it is tested against fixtures with no network.

## Running it locally

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```bash
pnpm install
createdb ava_dev                              # or: psql -c 'create database ava_dev'
cp .env.example .env                          # then edit it

export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ava_dev
pnpm db:migrate

# Interface: http://localhost:3000 — sign up with the administrator address (ADMIN_EMAILS, default harryddryden@gmail.com) and confirm it
export SESSION_SECRET=$(openssl rand -hex 32)
pnpm dev:web

# Worker, in another terminal
export ANTHROPIC_API_KEY=sk-ant-...           # optional: without it, scanning works and scoring is skipped
export SCRAPER_CONTACT_EMAIL=you@example.com
pnpm dev:worker
```

### Doing it from the command line instead

```bash
cd apps/worker

# Dry run: what would discovery find for a URL? Touches nothing.
pnpm cli probe https://www.anduril.com/open-roles
pnpm cli probe https://www.anthropic.com

pnpm cli add https://www.anduril.com https://www.anthropic.com
pnpm cli drain      # runs queued work now instead of waiting for the scheduler
pnpm cli list       # companies, the source found for each, role and follower counts
pnpm cli users      # accounts and what each follows (AVA_CLI_USER picks who the CLI acts for)
pnpm cli table      # the roles table as text
pnpm cli scan       # queue a full run
```

## Deploying

Full instructions, including what to set where and what to do when something is wrong, are in
[docs/DEPLOY.md](docs/DEPLOY.md). In short:

- **Database and worker on Render, interface on Vercel** (recommended). `render.yaml` is a
  blueprint that creates the worker from `Dockerfile`; in Vercel, import the repository
  and set the root directory to `apps/web`. Roughly £11 a month plus model usage.
- **Vercel only, with a Render database.** A Vercel Cron calls `/api/cron`, which runs the same
  scheduler and handlers inside the request. Roughly £5 a month, but there is no headless browser,
  so a careers page whose roles arrive by JavaScript has to have its board URL pasted in by hand.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | both | PostgreSQL connection string |
| `SESSION_SECRET` | web | signs the session cookie; changing it signs everyone out |
| `APP_URL` | web | the public origin, used in emailed links and the Google redirect (defaults to the request's host) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web | optional; enables "Continue with Google". Redirect URI: `<APP_URL>/auth/google/callback` |
| `ADMIN_EMAILS` | web | comma-separated administrator addresses; defaults to `harryddryden@gmail.com`. They may always sign up, become administrators once their address is confirmed, and the first of them to confirm inherits the data migrated from a single-user deployment. Everyone else can only sign up while an administrator has opened registration in Admin |
| `RESEND_API_KEY`, `EMAIL_FROM` | web | optional; sends confirmation and password-reset emails through Resend (set `APP_URL` with them). Without a provider the links are written to the server log, `AUTH_EMAIL_LOG=0` keeps them out, and an administrator can mint reset links from Admin |
| `AVA_CLI_USER` | worker | email of the account the CLI acts for; default is the earliest administrator |
| `ANTHROPIC_API_KEY` | worker | optional; without it scanning still works and scoring is skipped |
| `SCRAPER_CONTACT_EMAIL` | worker | included in the user agent so site owners can reach you |
| `TZ` | worker | the timezone the daily run is scheduled in |
| `WORKER_CONCURRENCY` | worker | parallel tasks, default 3 |
| `CHROMIUM_EXECUTABLE_PATH` | worker | only needed outside the Docker image |
| `CRON_SECRET` | web | required only for the Vercel-cron deployment; Vercel sends it as a bearer token |
| `AVA_DISABLE_BROWSER` | both | set to `1` where there is no Chromium, such as Vercel |

The `AVA_*` variables were named `CHRISTOPHER_*` before the product was renamed. The old names are
still read wherever the new ones are unset, so a deployment that sets them keeps working; move them
to the new names when convenient.

Everything else, including keywords, locations, the run time and the model, is edited in Settings and
stored in the database. Each account has its own monthly AI budget, $25 to start, and that is the
only budget: its holder changes it on Settings, an administrator changes anyone's in Admin ›
Accounts. It runs on the calendar month and starts again on the 1st, and Admin › Operations reports
what was spent by account, feature and model — alongside how each feature performed (latency, cache
hit rate, and failures kept apart from cancellations), what each of the last twenty CV builds cost
step by step, and the outbound traffic to every host we fetched from, with its 304 share, rate
limiting and week-on-week change. [docs/DEPLOY.md](docs/DEPLOY.md#observability) says which ledger
records what, how long each is kept, and how to answer the usual operational questions from them.
`DAILY_AI_BUDGET_USD` and `DISCOVERY_AI_BUDGET_USD` are optional safety valves for the deployment
as a whole, unset by default.

## Tests

```bash
pnpm -r test          # unit tests and the end-to-end suite
pnpm -r typecheck
```

The end-to-end suite starts a fake company website and runs the real code against a real database:
adding a homepage URL, discovering its Greenhouse board, scanning it, filtering by keyword and
location, and closing a role that disappears. It needs PostgreSQL; set `TEST_DATABASE_URL` or use the
default `ava_test` database.

## Checking it against a real site

The discovery pipeline was built against the two shapes these examples use, and both are covered by
tests using fixtures:

| Example | Shape | How it resolves |
|---|---|---|
| `anduril.com/open-roles` | A page whose roles are loaded by JavaScript | Headless Chromium renders it; the applicant tracking system is recognised from the API call the page makes, or from the JavaScript bundle if no browser is available |
| `anthropic.com/careers/jobs` | A careers landing page that links on to the listing | The careers link is followed, the listing's job links are recognised as a hosted board, and the board's feed is read directly |

This environment has no outbound access to those domains, so they were reproduced as fixtures rather
than fetched. Run `pnpm cli probe <url>` on your own machine to see what discovery finds for a real
site: it prints the candidates, their confidence, the evidence behind each and the full log, and
writes nothing to the database.

## Behaviour worth knowing

- **"How long live" is honest about its source.** Applicant tracking systems usually publish a posted
  date and that is used. Plain HTML pages rarely do, so the figure counts from when this tool first
  saw the role and is marked with an asterisk. Roles found on a company's very first scan are flagged
  as seeded, so day one does not read as a flood of new jobs.
- **Keywords are a hard filter; learning ranks within it.** The model never silently removes a role
  from your table, and never hides one by score. It scores and orders them, and proposes keyword and
  location changes for you to accept or reject on Learning.
- **Blocked sites are reported, not fought.** Bot protection marks a source blocked and puts it on the
  Health page. The usual fix is pasting the underlying board URL, which is rarely protected.

### Role filtering, table clean-up and CVs

Settings supports separate role and title-seniority keyword lists, combined with location filtering. Use `strateg*` for strategy/strategic. The table groups roles by what you have decided, and archive/restore is reversible. Dismissing a role asks for a reason, because that is what the ranking learns from.

CV builder maintains a versioned evidence library and creates saved CVs for individual roles using a separately selected Anthropic model. Import/export the library as JSON, edit draft text, and download a selectable-text A4 PDF. Apply migrations and run the background worker with `ANTHROPIC_API_KEY` before generating. Missing credentials are shown on the draft; local tests do not call paid models. See [the specification](docs/SPEC.md) and [validation record](docs/REVIEW-PLAN.md).

### Discover companies from external sources

In **Discover companies → Sources**, add websites, LinkedIn posts/newsletters, or emailed
newsletters. Each source checks weekly by default, with a configurable 1–90 day interval, pause and
Check now controls. Relevant companies are verified and presented with a source link, supporting
quote and rationale for your approval. Emailed content can be pasted or delivered through the
authenticated inbound endpoint. See [email delivery and source setup](docs/DEPLOY.md#external-company-discovery-and-emailed-newsletters).
