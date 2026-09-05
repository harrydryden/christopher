# Christopher — web

Next.js (App Router) UI for Christopher, the single-user careers page monitor. See
[`docs/SPEC.md`](../../docs/SPEC.md) at the repo root for the full product spec.

This app only reads and writes the shared Postgres database (`@christopher/db`) — it never
calls the worker directly. Mutations write rows and/or enqueue rows in the `tasks` table; the
worker (`apps/worker`) picks those up and does the scraping, scanning and AI calls.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. Pooled with at most 3 connections per serverless function. |
| `SESSION_SECRET` | yes | Any long random string. Signs the session cookie (HMAC-SHA256). Changing it signs everyone out. |
| `APP_PASSWORD_HASH` | yes (to log in) | Output of the `hash-password` script below. Without it, `/login` shows setup instructions instead of a password form. |
| `DATABASE_SSL` | no | `disable` \| `require` \| `verify`. Auto-detected from the host (`localhost`/`127.0.0.1`/`*.internal` → disabled, otherwise `require`) when unset. |

No Anthropic API key is used here — all AI calls happen in the worker.

## Local run

From the repo root (dependencies are installed at the workspace root already):

```bash
# 1. Start Postgres and make sure the schema is migrated (see packages/db).
#    e.g. pg_ctlcluster 16 main start

# 2. Generate a password hash for your chosen password:
pnpm --filter @christopher/web hash-password 'your password'
# prints: scrypt$16384$8$1$<salt>$<hash>

# 3. Run the dev server:
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/christopher_dev \
SESSION_SECRET=some-long-random-string \
APP_PASSWORD_HASH='scrypt$16384$8$1$...' \
pnpm --filter @christopher/web dev
```

Then open http://localhost:3000, log in with the password you hashed, and add a company by
homepage URL from the Companies page. Discovery, scanning, scoring and every other AI-driven
step happen in `apps/worker`, which must be running (with `ANTHROPIC_API_KEY` set) against the
same `DATABASE_URL` for anything beyond viewing/editing to actually happen.

`npx tsc --noEmit` and `npx next build` should both be clean from this directory.

## Vercel setup

- **Root directory:** `apps/web`
- **Install command:** run from the repo root, e.g. `pnpm install --frozen-lockfile` (Vercel's
  default monorepo install already does this when the project root directory is set as above).
- **Build command:** `pnpm --filter @christopher/web build`
- **Environment variables:** `DATABASE_URL`, `SESSION_SECRET`, `APP_PASSWORD_HASH` (see table
  above) — set for Production (and Preview, if you want previews to log in against the same
  database).
- The Postgres database itself is **not** hosted on Vercel (see the architecture doc) — point
  `DATABASE_URL` at wherever it runs, with SSL enabled for any non-local host.
- Vercel's Hobby plan is sufficient; there is nothing CPU- or memory-heavy in this app (no
  headless browser, no AI calls — those are the worker's job).

## Notable implementation choices

- `lib/db.ts` builds its own Drizzle client from `@christopher/db/schema` rather than calling
  `getDb()` from the package root (`@christopher/db`). That root barrel also re-exports
  `runMigrations`, which resolves its migrations folder via
  `new URL("../drizzle", import.meta.url)` — Next's webpack build statically analyses that
  pattern as an asset reference and fails to bundle it ("Module not found: Can't resolve
  '../drizzle'"), even though this app never calls it (migrations run from the worker on boot).
  Importing only the `schema` subpath sidesteps it entirely. `lib/enqueue.ts` reimplements
  `enqueueTask` for the same reason.
- `lib/settings.ts` patches one field after calling `resolveSettings()` from `@christopher/core`:
  that function's `typeof def !== typeof val` guard compares a stored `hideThreshold` override
  (a number) against its default (`null`, `typeof` `"object"`), so the guard always rejects it
  and the setting can never move off its default through the normal path. This is the only
  settings key affected (every other default shares its overrides' type). The fix belongs in
  `packages/core/src/settings.ts`; this is a local workaround so "hide roles under a fit score"
  actually takes effect from this app in the meantime.
- Status filtering, location substring matching and sorting for the roles table happen in JS
  after a single broad query (`lib/queries/jobs.ts`), per the spec's guidance for this scale
  (a single user, a few thousand rows) — simpler and easier to get right than the equivalent SQL.
