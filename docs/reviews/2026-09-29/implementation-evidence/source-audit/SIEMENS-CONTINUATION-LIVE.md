# Siemens HTTP continuation: bounded live audit

Observed 29 September 2026, 15:10–15:15 UTC. This was a read-only public listing fetch through the normal worker fetcher and its robots and host-pacing checks. It used an isolated local PostgreSQL database, one Siemens source and task, no followers, no AI provider, and no browser. `ava-source-diagnostic@example.invalid` was an explicitly labelled diagnostic user-agent identity reused from the existing source probe; it is **not** a production contact configuration. No job application or paid provider call was made.

The exact commands were run from the repository root:

```sh
docker exec jtbd-90-postgres-20260929 psql -U postgres -d postgres -Atqc "select 1 from pg_database where datname='ava_source_live'" | rg -q '^1$' || docker exec jtbd-90-postgres-20260929 createdb -U postgres ava_source_live
DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55439/ava_source_live' pnpm --filter @ava/worker exec tsx src/live-html-continuation.ts --init
SCRAPER_CONTACT_EMAIL='ava-source-diagnostic@example.invalid' DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55439/ava_source_live' pnpm --filter @ava/worker exec tsx src/live-html-continuation.ts --claims 2 --out '/Users/h_dryden/Documents/New project/christopher-jtbd-review/docs/reviews/2026-09-29/implementation-evidence/source-audit/siemens-continuation-live.json'
SCRAPER_CONTACT_EMAIL='ava-source-diagnostic@example.invalid' DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55439/ava_source_live' pnpm --filter @ava/worker exec tsx src/live-html-continuation.ts --claims 2 --max-pages 80 --out '/Users/h_dryden/Documents/New project/christopher-jtbd-review/docs/reviews/2026-09-29/implementation-evidence/source-audit/siemens-continuation-live.json'
```

The database already existed in this session, so the `createdb` command was guarded by an existence check. The two claim commands ran in separate OS processes. `--max-pages` is a cumulative ceiling across both processes: 40 by default on the first command, explicitly 80 on the second. Each process had a six-minute wall limit, each claim a three-minute worker deadline, and the handler yielded by 100 seconds or 20 new pages. The full generation has a two-hour safety expiry, 600-page, 5,000-posting and 3 MB checkpoint-metadata ceilings. These limits prevent unbounded work; they are not a claim that the daily run meets its 15-minute release gate.

| Claim (UTC) | Claim time | Listing fetches | New cumulative pages | New cumulative roles | Published jobs | Task |
|---|---:|---:|---:|---:|---:|---|
| 15:11:44 | 50.8 s | 20 | 20 | 120 | 0 | queued |
| 15:12:42 | 56.8 s | 22 | 40 | 240 | 0 | queued |
| 15:13:44, new process | 54.6 s | 22 | 60 | 360 | 0 | queued |
| 15:14:43 | 58.4 s | 22 | 80 | 480 | 0 | queued |

The listing generation started at 15:10:53.590 UTC; the fourth claim finished at 15:14:43.776 UTC, about 230 seconds of elapsed generation time. At that boundary the same source fingerprint (`127b89c6a007ccf5f5dc3200f3fd14a661215dd93776abe105c228042f61d891`) remained in one checkpoint, with zero restarts and task attempts refunded to zero. PostgreSQL held 80 staged pages, 480 postings, an advertised lower bound of 999 roles, 81,168 bytes of page metadata, and cumulative counters of 86 requests, 14,013,484 response bytes and 220,461 ms active work. The terminal state was **not reached**: the task was queued, with no `scans` row or published `jobs` row. This confirms persistence across processes and no premature claim of completeness, but does not establish that the whole board can be read.

The first-party page says `999+ results` and serves six roles per page, so at least 167 pages are needed. At the observed pace, that lower bound would take about eight minutes of active claims; the actual total is undisclosed and may take longer than the 15-minute release gate or exceed a generation cap. A single source also does not measure a 50-company daily run. The audit stopped at 80 pages as authorised; a terminal scan, recall, final reconciliation and the 50-company/15-minute gate remain unverified. The machine-readable [claim evidence](siemens-continuation-live.json) contains only aggregate metrics, timestamps and the source fingerprint.
