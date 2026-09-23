# Working in this repository

AVA watches company careers pages daily and keeps a filtered, learnable table of roles.
[docs/SPEC.md](docs/SPEC.md) is the contract; read the relevant section before changing behaviour.

## Layout

| Path | What lives there |
|---|---|
| `packages/core` | Everything that decides accuracy: discovery, ATS adapters, extraction, the keyword and location gate, change detection. Pure: fetchers are injected, so it is all testable without a network. |
| `packages/ai` | One method per model call site (A1–A10 in the spec). Streamed, schema-validated, prompt-cached, post-checked. |
| `packages/db` | Drizzle schema, migrations, task queue helpers. |
| `apps/worker` | Scheduler, task queue, polite fetcher, headless browser, task handlers, operational CLI. |
| `apps/web` | Next.js interface. Server components read; server actions write and enqueue tasks. |

The interface never calls the worker. It writes rows into `tasks`; the worker polls that table.

## Commands

```bash
pnpm -r typecheck
pnpm -r test                 # needs PostgreSQL for the worker suites
pnpm db:migrate              # DATABASE_URL must be set
pnpm seed:demo               # realistic data for exercising the interface
pnpm smoke:web               # build the interface, sign in, fetch every page

cd apps/worker
pnpm cli probe <url>         # dry run: what would discovery find?
pnpm cli drain               # run queued tasks now
pnpm cli table               # the roles table as text (AVA_CLI_USER picks the account)
pnpm cli users               # accounts and what each follows
```

The worker suites share one database and truncate between tests, so `fileParallelism` is off. Set
`AVA_DISABLE_BROWSER=1` to skip the Chromium test.

## Rules that are load-bearing

- **Only a successful scan may close a role**, and only after two consecutive misses. Anything that
  weakens this produces false "closed" rows, which is the failure the user will notice first.
- **The keyword and location gate is a hard filter the user controls.** The model ranks within it and
  proposes changes; it never removes a role from the table on its own.
- **The catalogue is shared; the table is per account.** `companies`, `career_sources` and every
  observed posting in `jobs` exist once for everyone, and a company is scanned once a day however
  many accounts follow it. What an account sees is its `user_jobs` view, created only when that
  account's gate passes (spec: "Store matching roles only", per account). Scan completeness and
  closure detection use the full observed listing; widening a gate admits stored postings at once,
  and narrowing it archives that account's non-matching views unless they carry a decision or a
  saved CV. Every query, action and task payload that touches per-account data carries a `userId`;
  never read or write `user_jobs`, decisions, settings, profiles, suggestions, CVs or applications
  without one.
- **Authentication is a database row, not a cookie.** Middleware checks the cookie signature only;
  `getCurrentUser()` decides. Server actions and route handlers call `requireUser()`, or
  `requireAdmin()` for the shared schedule, models, catalogue edits and account
  management, before any read or write; work that scans, discovers or calls a model goes through
  `requireVerifiedUser()`. The administrator role and the migrated owner's data go only to an
  `ADMIN_EMAILS` address that has been proven (a Google-verified sign-in, the confirmation link
  completed with the password, or a reset link). Never grant either at registration.
- **Model output is never trusted directly.** Extracted URLs must exist on the page, tags must come
  from the vocabulary, suggested companies must verify. Scraped content goes in tagged blocks in the
  user turn, never in the system prompt.
- **The interface has one design system and it is enforced by the tokens.**
  [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) describes it; `apps/web/app/globals.css` clears
  Tailwind's default colour, radius, shadow and type scales, so `text-slate-500` and `rounded-lg`
  silently do nothing. Compose the components in `apps/web/components`, or add a token — never an
  arbitrary value. CV document palettes are deliberately outside it.
- Prefer an ATS feed over HTML. Adding an adapter is usually better than improving the HTML fallback.

## Adding an ATS adapter

Write `packages/core/src/ats/<name>.ts` exporting an `Adapter` and a `<name>Spec(slug)` builder,
register it in `registry.ts`, add a fixture in `src/fixtures/index.ts`, and add cases to
`src/ats/ats.test.ts` for `specFromUrl` (positive and negative), `fetchPostings` field mapping, and
`verify` on a 404. Endpoint shapes marked *verify* in the spec's Appendix A are unofficial: confirm
them against a real board before relying on them.
