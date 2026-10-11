# Paid launch readiness — 11 October 2026

This is a handover of evidence and remaining decisions, not permission to turn on live payments. The
review started from commit `f8b02db`. Keep the release commit and its check links with the final
launch record; later changes need their own checks. Do not put secrets in this document.

## Current evidence

| Area | Evidence | Result and limit |
|---|---|---|
| Deployment health | Web and worker health checked against `f8b02db` | Both answered OK at the reviewed base. This does not certify the next release. |
| CI and release | [Main run 37673157778](https://github.com/harrydryden/christopher/actions/runs/37673157778), attempt 2; [Release 38166148002](https://github.com/harrydryden/christopher/actions/runs/38166148002) | All five main CI jobs, including browser, smoke and bundle checks, passed on the rerun; all three release jobs then passed for `f8b02db`. Attempt 1 had stalled on an Ubuntu apt mirror and timed out. The candidate bounds apt waits and gives installation a five-minute command limit; that change still needs its own PR CI run. |
| Evaluation | `COL_EVAL_GATE_REQUIRE_VERIFIED=1 node --import tsx scripts/check-evaluation-reports.ts` | Passed locally for shipped prompt set `11ae22aed3fe`, with three committed reports. Two older reports are marked unverified; the verified result is a limited saved author/review replay, not a fresh end-to-end CV quality assessment. |
| Code checks | Frozen `pnpm install`; workspace typechecks; release script suite | Passed locally. Release script suite: 134 passed against a disposable migrated database; auth, account access and tenant isolation suites: 238 passed against a separate disposable database. The live billing and browser journeys still need their own proof. |
| Operations | [Run 38147742272](https://github.com/harrydryden/christopher/actions/runs/38147742272) | Passed, with heap at or above 75% in all three samples. Queue was zero, crashes zero in 24 hours and AI failures zero in one hour. Observed runs were 3–7 hours apart despite a 15-minute cron; neither the intended cadence nor alert delivery has been proven. |
| Capacity | [Run 37478919547](https://github.com/harrydryden/christopher/actions/runs/37478919547), commit `9273ff0`, [artifact 11421186077](https://github.com/harrydryden/christopher/actions/runs/37478919547/artifacts/11421186077) | At ten active readers, p95 was 586 ms with zero errors; writes were 109 ms and a 60-second soak 414 ms, both with zero errors. Three 100-session bursts were 3621, 3754 and 3741 ms, above the 2000 ms target. This older-commit stress result remains a launch risk. |
| Worker memory | Existing local and hosted evidence in [deployment guide](DEPLOY.md) | 512 MiB worker headroom previously failed; a 1 GiB local run passed. Hosted memory headroom has not been proved. |
| Repository controls | GitHub main branch | Main has no branch protection or ruleset. A green CI run is not currently enforced before changes land. |
| Dependency audit | Candidate lockfile | Next.js `15.5.27`, Sharp `0.35.5` and `source-map-js` `1.2.2` address high-severity findings; the existing Next.js hydration patch was updated for that exact version. One moderate advisory remains in Mammoth's CLI dependency `sprintf-js` (`GHSA-hp3w-g68c-fv3c`). The app uses Mammoth's `extractRawText` API, but the residual still needs a tracked update or accepted exception. |

## Implemented in this candidate

Checkout now checks for a configured webhook signing secret before offering a charge. Webhook
processing uses paid invoice plan lines and billing periods for monthly CV credits, handles invoice
line pagination, and serialises top-up fulfilment against refunds and disputes. An account with a
Stripe subscription attached cannot be deleted through the administrator action. An in-flight
Checkout can precede the webhook that stores the subscription id, so deletion still requires a
Stripe reconciliation. These are code and local-test results, not a substitute for Stripe test-mode
reconciliation. Billing tests passed: web billing 18/18 and database billing 3/3; a production web
build and workspace typechecks also passed after the dependency update. The offline
`check:launch-config` command checks web and worker settings separately, requires explicit live or
test mode, and names unset deployment-wide AI caps. An optional read-only Stripe Price check compares
the six configured Prices with the in-code catalogue; it has not been run against a Stripe account.
CI bounds apt mirror waits so browser checks fail visibly if the mirror stalls. Dependency fixes
and their advisory review are recorded above.

## Ordered launch checklist

The people managing the provider accounts, business terms and pilot approve the decisions below.
Engineering can carry out the implementation and verification once those inputs exist.

- [ ] **Establish the release gate.** Protect `main`, require the relevant CI jobs and review, then
  obtain a green run for the exact candidate commit. Keep the browser, smoke and bundle evidence.
  Gate provider auto-promotion so an unverified commit cannot reach customers before CI and release
  checks finish: the current Release workflow checks identities that may already have deployed.
  Record a release promotion or rollback owner. The successful baseline rerun does not certify the
  candidate changes until their PR checks pass.
- [ ] **Decide paid terms and customer support.** Confirm the trading entity, pricing and VAT
  treatment, privacy and terms wording, refund policy, support channel and retention policy with
  appropriate human review. Publish only approved wording. Record who handles disputes and account
  deletion requests.
- [ ] **Approve the economics and capacity envelope.** Members can raise their own monthly AI
  budget from the $25 default to $100; administrators can raise it further. CV credits constrain CV
  builds, but do not bound scoring or discovery. Agree expected account numbers and provider cost,
  set `DAILY_AI_BUDGET_USD` and `DISCOVERY_AI_BUDGET_USD` to deliberate values, and confirm what
  users see when a cap stops work. Review the failed 100-session bursts and hosted worker memory
  before choosing a pilot size. Prove provider backup and isolated full-app restore against the
  stated RPO/RTO targets before promising them.
- [ ] **Configure Stripe test mode and prove the payment matrix.** Create the six GBP Prices in
  [billing setup](BILLING-SETUP.md), webhook with all nine listed events, and Portal settings with
  customer-controlled quantity changes disabled. Migrate through `0060_evidence_drafts` and run
  `pnpm check:launch-config --surface=web --mode=test` against the web test environment. Run
  `pnpm check:stripe-catalogue --mode=test` with the test key and Price ids, then exercise
  Search and Intensive purchases, each CV top-up, company-block change, webhook retry and ordering,
  failed renewal, cancellation, refund and dispute; reconcile Stripe objects against entitlements
  and ledger rows. Save redacted evidence and resolve mismatches. The full failure and dispute matrix
  belongs in Stripe test mode.
- [ ] **Configure delivery and operations.** Set a verified transactional email sender/domain and
  prove confirmation, password reset and billing receipt delivery. Disable `AUTH_EMAIL_LOG=1`.
  Name an alert owner and backup, wire a channel that actually reaches them, and test a triggered
  alert. Investigate the observed 3–7-hour operations run gaps or agree a staffed inspection
  schedule. Record the restore procedure and operator contacts.
- [ ] **Prepare live mode with explicit approval.** Copy the verified Stripe catalogue into live
  mode, configure live web/worker settings separately and run
  `pnpm check:launch-config --surface=web --mode=live` and
  `pnpm check:launch-config --surface=worker --mode=live` in their
  respective environments. Run `pnpm check:stripe-catalogue --mode=live` with the live web key and
  Price ids. The optional Stripe check verifies Price fields but not the tax outcome or webhook and
  Portal configuration; manually confirm those, the checkout total and sender domain.
  With the owner's approval, make a controlled purchase, cancellation and refund using an authorised
  payment method. Approve a limited pilot and monitor its first purchases, CV builds and spend.
- [ ] **Prove product quality with people.** Recruit pilot users who can judge their own CVs.
  Complete a fresh import → evidence planning → draft → PDF journey with representative adverts,
  collect human labels for extraction and writing quality, and fix failures that affect a paid
  promise. The saved evaluation gate alone does not answer that question.

The owner must approve and document how account data access, export and deletion requests will be
handled, including retained billing records and backups. A self-service request interface and
broader export tooling are not implemented; engineering can add required tooling once the policy
is set. An administrator must check for an in-flight Checkout and reconcile Stripe before deleting
an account; the stored subscription guard alone does not prove charges have stopped. The
[deployment guide](DEPLOY.md) contains detailed restore and operations procedures, and
[billing setup](BILLING-SETUP.md) is the source for Stripe catalogue and event configuration.
