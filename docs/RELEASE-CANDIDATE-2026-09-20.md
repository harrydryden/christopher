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
- An end-to-end assisted discovery regression proves that a supplied board URL is verified,
  activated, scanned and filtered into the person's table after automatic discovery failed.
- Frozen extraction evidence now covers 3,423 identities across eight sources, including two
  Workday enterprises, with an identical offline replay. These are independently implemented
  machine labels, not human-reviewed golden labels.
- Review found and fixed confirmed quiz evidence being appended to an inactive employment entry.
  It now creates an active entry while preserving the inactive history.
- Rollout guidance now requires migration first, verified web second, worker last. Once quiz or
  continuation data exists, prefer roll-forward; older binaries do not understand that lifecycle.

## Open acceptance evidence

The initial follow-up full 25-company browser run, with three concurrent discoveries sharing one
browser, recorded 13 correct automatic selections (52%) and one wrong automatic selection: Canonical's
hiring-process page. This failure is retained in `live-acceptance-release-candidate-2026-09-20.json`.
Focused successes must not replace this full-cohort result. Discovery fixes and a repeat remain in
progress. The production candidate serialises company verification; any later serial observation
must state that configuration and preserve this concurrent diagnostic separately.

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
- `EXTRACTION-REVIEW-PACK-2026-09-20.md`
- `CV-QUALITY-EVALUATION.md`
- `DEPLOY.md`
