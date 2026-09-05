# Christopher

Watches the careers pages of companies you list, once a day. Keeps a table of the roles that match
your keywords **and** your locations, tracks how long each has been live and when it closes, and
learns which roles to put in front of you from the reasons you give when you apply or skip. It also
recommends companies similar to the ones you already track.

Single user. Give it a homepage URL and it finds the careers page itself.

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
createdb christopher_dev                      # or: psql -c 'create database christopher_dev'
cp .env.example .env                          # then edit it

export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/christopher_dev
pnpm db:migrate

# Interface: http://localhost:3000
export SESSION_SECRET=$(openssl rand -hex 32)
export APP_PASSWORD_HASH=$(pnpm --filter @christopher/web hash-password 'your password' | tail -1)
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
pnpm cli list       # companies, the source found for each, role counts
pnpm cli table      # the roles table as text
pnpm cli scan       # queue a full run
```

## Deploying

**Database and worker (Render).** `render.yaml` is a blueprint: point Render at this repository and
it creates a Postgres instance and one always-on worker service built from
`apps/worker/Dockerfile`. Set `ANTHROPIC_API_KEY` and `SCRAPER_CONTACT_EMAIL` in the dashboard. The
worker runs migrations on boot behind an advisory lock, so it is safe to redeploy at any time. A web
service is used rather than a cron job because the scheduler and the on-demand queue must both be
running.

**Interface (Vercel).** Import the repository, set the root directory to `apps/web`, and set
`DATABASE_URL` (the external connection string from Render, which needs TLS), `SESSION_SECRET` and
`APP_PASSWORD_HASH`. Vercel's egress addresses vary, so the database is protected by TLS and a strong
password rather than an IP allowlist. The interface never calls the worker: it writes rows into the
`tasks` table and the worker picks them up within seconds.

Roughly $14 a month for Render, plus model usage, which the Health page tracks against a budget you
set.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | both | PostgreSQL connection string |
| `SESSION_SECRET` | web | signs the session cookie |
| `APP_PASSWORD_HASH` | web | scrypt hash of your password, from `pnpm --filter @christopher/web hash-password` |
| `ANTHROPIC_API_KEY` | worker | optional; without it scanning still works and scoring is skipped |
| `SCRAPER_CONTACT_EMAIL` | worker | included in the user agent so site owners can reach you |
| `TZ` | worker | the timezone the daily run is scheduled in |
| `WORKER_CONCURRENCY` | worker | parallel tasks, default 3 |
| `CHROMIUM_EXECUTABLE_PATH` | worker | only needed outside the Docker image |

Everything else, including keywords, locations, the run time and the model, is edited in Settings and
stored in the database.

## Tests

```bash
pnpm -r test          # unit tests and the end-to-end suite
pnpm -r typecheck
```

The end-to-end suite starts a fake company website and runs the real code against a real database:
adding a homepage URL, discovering its Greenhouse board, scanning it, filtering by keyword and
location, and closing a role that disappears. It needs PostgreSQL; set `TEST_DATABASE_URL` or use the
default `christopher_test` database.

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
  from your table. It scores and orders them, proposes filter changes for you to accept, and surfaces
  near-misses in their own section, which you can switch off in Settings.
- **Blocked sites are reported, not fought.** Bot protection marks a source blocked and puts it on the
  Health page. The usual fix is pasting the underlying board URL, which is rarely protected.
