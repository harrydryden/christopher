# Working in this repository

Christopher watches company careers pages daily and keeps a filtered, learnable table of roles.
[docs/SPEC.md](docs/SPEC.md) is the contract; read the relevant section before changing behaviour.

## Layout

| Path | What lives there |
|---|---|
| `packages/core` | Everything that decides accuracy: discovery, ATS adapters, extraction, the keyword and location gate, change detection. Pure: fetchers are injected, so it is all testable without a network. |
| `packages/ai` | One method per model call site (A1–A10 in the spec). Schema-validated, prompt-cached, post-checked. |
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
pnpm cli table               # the roles table as text
```

The worker suites share one database and truncate between tests, so `fileParallelism` is off. Set
`CHRISTOPHER_DISABLE_BROWSER=1` to skip the Chromium test.

## Rules that are load-bearing

- **Only a successful scan may close a role**, and only after two consecutive misses. Anything that
  weakens this produces false "closed" rows, which is the failure the user will notice first.
- **The keyword and location gate is a hard filter the user controls.** The model ranks within it and
  proposes changes; it never removes a role from the table on its own.
- **Every posting is stored, whether or not it passes the gate.** That is what makes keyword changes
  retroactive and near-miss surfacing possible.
- **Model output is never trusted directly.** Extracted URLs must exist on the page, tags must come
  from the vocabulary, suggested companies must verify. Scraped content goes in tagged blocks in the
  user turn, never in the system prompt.
- **Near-miss scoring is capped per day.** It is the easiest way to turn a settings change into a
  large bill.
- Prefer an ATS feed over HTML. Adding an adapter is usually better than improving the HTML fallback.

## Adding an ATS adapter

Write `packages/core/src/ats/<name>.ts` exporting an `Adapter` and a `<name>Spec(slug)` builder,
register it in `registry.ts`, add a fixture in `src/fixtures/index.ts`, and add cases to
`src/ats/ats.test.ts` for `specFromUrl` (positive and negative), `fetchPostings` field mapping, and
`verify` on a 404. Endpoint shapes marked *verify* in the spec's Appendix A are unofficial: confirm
them against a real board before relying on them.
