# AVA — web

Next.js (App Router) UI for AVA, the careers page monitor: several accounts, one shared company catalogue. See
[`docs/SPEC.md`](../../docs/SPEC.md) at the repo root for the full product spec.

This app only reads and writes the shared Postgres database (`@ava/db`) — it never
calls the worker directly. Mutations write rows and/or enqueue rows in the `tasks` table; the
worker (`apps/worker`) picks those up and does the scraping, scanning and AI calls.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. Pooled with at most 3 connections per serverless function. |
| `SESSION_SECRET` | yes | Any long random string. Signs the session cookie (HMAC-SHA256), which names a row in `sessions`. Changing it signs everyone out. |
| `APP_URL` | no | Public origin for emailed links and the Google redirect URI. Defaults to the request's forwarded host. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | Enables "Continue with Google" (OAuth 2.0 code flow with PKCE; redirect URI `<APP_URL>/auth/google/callback`). |
| `ADMIN_EMAILS` | no | Comma-separated administrator addresses; defaults to `harryddryden@gmail.com`. They may always sign up, become administrators once their address is confirmed, and inherit data migrated from a single-user deployment. Everyone else signs up only while registration is open (Admin) and joins as a member. |
| `RESEND_API_KEY`, `EMAIL_FROM` | no | Sends confirmation and password-reset emails through Resend; set `APP_URL` with them. Without a provider the links are written to the server log (`AUTH_EMAIL_LOG=0` keeps them out) and administrators can mint reset links from Admin. |
| `DATABASE_SSL` | no | `disable` \| `require` \| `verify`. Auto-detected from the host (`localhost`/`127.0.0.1`/`*.internal` → disabled, otherwise `require`) when unset. |

No Anthropic API key is used here — all AI calls happen in the worker.

## Local run

From the repo root (dependencies are installed at the workspace root already):

```bash
# 1. Start Postgres and make sure the schema is migrated (see packages/db).
#    e.g. pg_ctlcluster 16 main start

# 2. Run the dev server:
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/ava_dev \
SESSION_SECRET=some-long-random-string \
pnpm --filter @ava/web dev
```

Then open http://localhost:3000/signup, sign up with the administrator address (`ADMIN_EMAILS`,
default `harryddryden@gmail.com`), complete the confirmation link from the server log with your
password, and add a company by homepage URL from the Companies page. Discovery, scanning, scoring and every other AI-driven
step happen in `apps/worker`, which must be running (with `ANTHROPIC_API_KEY` set) against the
same `DATABASE_URL` for anything beyond viewing/editing to actually happen.

`npx tsc --noEmit` and `npx next build` should both be clean from this directory.

## Vercel setup

- **Root directory:** `apps/web`
- **Install command:** run from the repo root, e.g. `pnpm install --frozen-lockfile` (Vercel's
  default monorepo install already does this when the project root directory is set as above).
- **Build command:** `pnpm --filter @ava/web build`
- **Environment variables:** `DATABASE_URL`, `SESSION_SECRET`, plus the optional sign-in and
  email variables in the table above — set for Production (and Preview, if you want previews to
  sign in against the same database).
- The Postgres database itself is **not** hosted on Vercel (see the architecture doc) — point
  `DATABASE_URL` at wherever it runs, with SSL enabled for any non-local host.
- Vercel's Hobby plan is sufficient; there is nothing CPU- or memory-heavy in this app (no
  headless browser, no AI calls — those are the worker's job).

## Notable implementation choices

- `lib/db.ts` builds its own Drizzle client from `@ava/db/schema` rather than calling
  `getDb()` from the package root (`@ava/db`). That root barrel also re-exports
  `runMigrations`, which resolves its migrations folder via
  `new URL("../drizzle", import.meta.url)` — Next's webpack build statically analyses that
  pattern as an asset reference and fails to bundle it ("Module not found: Can't resolve
  '../drizzle'"), even though this app never calls it (migrations run from the worker on boot).
  Importing only the `schema` subpath sidesteps it entirely. `lib/enqueue.ts` reimplements
  `enqueueTask` for the same reason.
- Automatic score hiding is retired. Nothing writes `hideThreshold` any more and nothing reads it:
  the minimum-fit filter on Roles is the only way a score narrows the table, and it belongs to the
  reader. Stored values (and stored `hide_threshold` filter suggestions, which Accept settles
  rather than applies) stay readable and are ignored.
- Status filtering, location substring matching and sorting for the roles table happen in JS
  after a single broad query (`lib/queries/jobs.ts`), per the spec's guidance for this scale
  (a few accounts, a few thousand rows each) — simpler and easier to get right than the equivalent SQL.
