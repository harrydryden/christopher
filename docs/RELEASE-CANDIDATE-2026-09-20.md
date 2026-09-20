# Release candidate — 20 September 2026

PR [#72](https://github.com/harrydryden/christopher/pull/72) contains the accumulated production review,
discovery/extraction work and evidence-led CV builder improvements. It remains a draft while the
release gates below are being completed. The owner has authorised PR creation and production
deployment when ready; that does not waive failed or unmeasured acceptance criteria.

## Completed follow-up

- The managed recovery copy accepted migration 0034 and the existing production build passed six
  authenticated read checks against it. Core counts, relationship checks and the user-job
  fingerprint were unchanged. The dedicated session was removed. This is application compatibility
  against the managed copy, not a complete hosted worker recovery or incident-to-restoration RTO.
- The Vercel release branch now has a dedicated Preview-only `DATABASE_URL` using the recovery
  copy's pooled endpoint. The original Production/Preview default has not been changed. A disposable
  account created only in that copy successfully signed in to the preview, demonstrating isolation.
- Hosted Companies, Applications and Library pages passed. Operations exposed a timestamp rendering
  exception; the retained report records a failure even though the streamed response had HTTP 200.
  The fix at `7008eb1` normalises raw aggregate timestamps before formatting them. Its hosted
  preview passed sign-in and all four pages, including nine historical CV-cost rows, nineteen worker
  events and six scan-input rows. This verifies rendering against the pooled recovery database;
  historical worker records are not evidence of a currently running recovery worker.
- An end-to-end assisted discovery regression proves that a supplied board URL is verified,
  activated, scanned and filtered into the person's table after automatic discovery failed.
- Frozen extraction evidence now covers 3,423 identities across eight sources, including two
  Workday enterprises, with an identical offline replay. These are independently implemented
  machine labels, not human-reviewed golden labels.
- Review found and fixed confirmed quiz evidence being appended to an inactive employment entry.
  It now creates an active entry while preserving the inactive history.
- Rollout guidance now requires migration first, verified web second, worker last. Once quiz or
  continuation data exists, prefer roll-forward; older binaries do not understand that lifecycle.
- The local 100-registered/10-active workload already passed; another 100-concurrent-user test is
  not required by the agreed launch target. A separate real-queue fixture drill completed fifty
  company scans in 0.458 seconds: 49 succeeded, one recorded its controlled failure, and all five
  existing roles at the failed source remained open. This establishes local queue timing and failure
  isolation. Public-provider pacing, browser and hosted daily-run timing remain unmeasured.

## Open acceptance evidence

The initial follow-up full 25-company browser run, with three concurrent discoveries sharing one
browser, recorded 13 correct automatic selections (52%) and one wrong automatic selection: Canonical's
hiring-process page. This failure is retained in `live-acceptance-release-candidate-2026-09-20.json`.
Focused successes must not replace a full-cohort result. The production candidate serialises
company verification; the separate production-shaped repeat is
`live-acceptance-release-serial-ai-2026-09-20.json`. With browser and production AI fallback enabled,
it recorded **17/25 correct automatic selections (68%)**, 19/25 correct source matches including
confirmation cases, and **one wrong automatic selection** of Siemens' belonging page. The 80%
automatic-discovery and zero-wrong-acceptance criteria therefore failed. The earlier Canonical
failure was corrected, but a targeted fix does not certify the cohort.

The Siemens defect came from four careers-navigation links being counted as vacancies, which
short-circuited the AI classifier. A title-and-path guard now rejects those navigation patterns.
The bounded post-fix Siemens check returns confirmation at 0.50 with zero automatic acceptances;
it still does not resolve the correct source. That report is retained separately as
`live-acceptance-siemens-navigation-guard-2026-09-20.json`. The full 25-company result above remains
the latest cohort evidence and remains a failure.

The serial run admitted 26 successful A2 calls and refused ten reservations under its conservative
$1 process cap. Reported usage cost was $0.271990; cumulative authorised evaluation usage is
$7.521925 of $10. No A1 call ran. These budget-limited observations do not establish unrestricted
AI fallback coverage. Browser/AI reachability and agreement are also separate from extraction
precision and recall, which this discovery-only run leaves unmeasured.

Human CV review and the remaining golden-set composition/labels are outstanding. The exact
extraction requirements and review inputs are in `EXTRACTION-REVIEW-PACK-2026-09-20.md`. No automated
agent review is described as a human review, and no threshold has been relaxed.

The 512 MB worker failed the prior memory-headroom test. Render's next available worker plan is
2 GB / 1 CPU at $25/month instead of $7/month. The $18/month recurring increase has been presented
to Harry for approval and has not been applied. Hosted representative capacity, 50-company timing,
full web/worker recovery, controlled alert delivery, and final production revision/journey checks
remain separate gates. No production migration, merge or deployment has been performed by this
follow-up.

## Evidence

- `benchmarks/managed-application-recovery-2026-09-20.json`
- `benchmarks/hosted-preview-read-smoke-2026-09-20.json`
- `benchmarks/hosted-preview-read-smoke-fixed-2026-09-20.json`
- `benchmarks/fifty-company-daily-run-2026-09-20.json`
- `EXTRACTION-REVIEW-PACK-2026-09-20.md`
- `CV-QUALITY-EVALUATION.md`
- `DEPLOY.md`
