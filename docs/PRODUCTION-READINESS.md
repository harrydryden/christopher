# Production readiness and owner checklist

Reviewed 12 November 2026 against merged main `6893adbd` (PR #145), with the
production-readiness cleanup branch layered on top. This replaces the November 5
forward plan. Earlier ADR verification notes remain historical evidence, not a
claim that the current release has been deployed or qualified.

## Readiness decision

Not yet approved for paid production. The accepted ADR implementation is present;
the remaining gates include external setup, live model qualification, security and
operational verification, as well as user testing. See the [ADR index](adr/README.md)
for scope and precedence. This review made no production configuration changes,
paid model calls, payments or hosted migrations.

Concrete cleanup in this review:

- Refuse unsupported `AI_PROVIDER` selections before constructing a live model
  client, in provider readiness and in both launch-configuration checks. Setting
  `AI_PROVIDER=munito` cannot silently keep using Anthropic. Omission preserves the
  existing Anthropic configuration; explicit fixture clients remain testable.
- Update `fast-xml-parser` from 5.11.1 to 5.12.0 for
  [GHSA-474x-hrwr-fgx4](https://github.com/advisories/GHSA-474x-hrwr-fgx4).
  The application does not configure the advisory's non-default `stopNodes`
  option; updating nevertheless removes the known vulnerable dependency.
- Consolidate current launch work and correct the obsolete claim that
  Experience-based catalogue recommendations still need initial implementation.

## Release gates — engineering and release owner

| Gate | Current evidence / action required | Completion evidence |
| --- | --- | --- |
| Candidate CI | Main run [43215052747](https://github.com/harrydryden/christopher/actions/runs/43215052747) was still running at review time. This cleanup needs its own PR checks. | All required checks green on the exact candidate commit |
| Live model qualification | The previous [Release run](https://github.com/harrydryden/christopher/actions/runs/43187314367) rejects unverified reports at prompt set `1c2f007d32f7`. Do not relabel fixture reports or weaken the gate. | Fresh passing, verified live build/replay reports for the final provider, models and prompt set; strict evaluation gate passes |
| Protected promotion | GitHub returned no classic protection and no effective rules for main on 12 November. Configure required review/checks and prohibit force pushes/deletion. The Release workflow checks qualification and deployed versions; it does not itself prevent Vercel/Render auto-deployment. | Required checks enforced; production promotion explicitly gated in the hosting configuration |
| Database and deployment | Review every migration since the actual deployed commit, including 0076 for durable CV activity. Back up and apply compatible migrations before code that reads the new schema. | Migration ledger, matching web/worker commit and hosted smoke results recorded; [rollout/rollback](DEPLOY.md) rehearsed |
| Runtime configuration | Run `pnpm check:launch-config --surface=web --mode=live` and the worker equivalent against their respective environments without printing secrets. | Both pass; provider/model access and pricing independently verified |
| Operations | Recheck capacity on the final candidate; older snapshots cannot establish current headroom. Prove alerts, stuck-task recovery and backup restoration. | Measured queue/latency/memory limits; alert received by named owner; isolated restore and rollback drill |

Prefer qualifying Munito before the final model evaluations and end-to-end launch
run, so they are not repeated against a provider that will immediately change.

## Your setup and decisions

1. **LinkedIn authentication.** Create the LinkedIn developer application and
   associated company Page, complete the required verification, and request the
   OpenID Connect sign-in product. Register the exact staging callback and
   `https://courseof.life/auth/linkedin/callback` for production. Configure the
   client ID/secret securely on the web service. Follow [LinkedIn setup](LINKEDIN-SIGN-IN.md).
   Test existing email accounts, new accounts, cancellation and missing email.
   Email claims are optional; matching email alone must not merge accounts.
   LinkedIn sign-in is not career-history import: onboarding still asks for the
   person's exported profile PDF, CV or documents. See [LinkedIn's OIDC contract](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2).

2. **Stripe billing.** Activate the business account and decide final prices,
   VAT/tax treatment, receipts and refund policy. Create the six test prices in
   [billing setup](BILLING-SETUP.md), configure Checkout, Customer Portal and the
   signed webhook, then repeat with separate live prices and secrets. Validate
   using `pnpm check:stripe-catalogue --mode=test` (then `--mode=live`). Test renewal,
   failed payment, cancellation, top-ups, refunds and duplicate/out-of-order
   delivery; reconcile money, credits and tier allowances. Only then authorise a
   controlled live purchase/refund. Subscription updates depend on asynchronous
   [Stripe webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).

3. **Munito.** Provision an account, scoped credentials, preferred processing
   region, spend limit and data-processing terms. Engineering must then implement
   and qualify the adapter; this remains real engineering work, not a dropdown or
   environment-variable switch. [Munito supports an Anthropic-compatible API](https://docs.munito.ai/compatibility),
   but unsupported parameters fail and hosted tools differ. Verify model IDs,
   prices, structured outputs, streaming, reasoning budgets, cancellation,
   retries, usage accounting, cache/batch capability and error handling. Update
   health and evaluation tooling too. Compare first-pass relevance, page fit,
   latency and total cost including retries, then canary with an explicit rollback.
   Do not silently send candidate data to another provider as a fallback.

4. **Domain and transactional email.** Connect `courseof.life`, set the canonical
   `APP_URL`, HTTPS and redirects, and update OAuth callbacks, Stripe URLs and
   email links. Configure the sender domain and SPF/DKIM/DMARC. Verify confirmation,
   reset and sign-in round trips on the final domain. Existing sessions may need
   a new sign-in across domains; existing accounts must remain the same.

5. **Final design and usability.** Sign off the visual system, mobile layouts,
   keyboard/focus behaviour, contrast, inline AI controls and exported PDFs.
   Test comprehension of Auto / Refine / Manual, saved state, progress,
   recoverable failures, one credit per role and editing allowances. Keep important
   controls visible and remove unnecessary explanation rather than hiding it in
   disclosure panels. Use representative applicants, contractors and consultants.

6. **End-to-end acceptance, especially CVs.** Run onboarding/import → Experience →
   recommendations/application → ranked role priorities → Auto → persistent Refine
   edits → optional Manual → finalise/download. Include parallel projects, all
   section types, skill ordering, fonts/page limits, reload/navigation while
   building, retries after failure, concurrent tabs, quota resets, warning
   overrides, conflict decisions and later rebuilds. Confirm saved words and
   immutable exports, not just successful clicks. Use the final model and domain.

7. **Security and privacy.** Arrange independent tenant-isolation, auth/account
   linking, CSRF, SSRF, uploads, payment and prompt-injection testing. Explicitly
   configure administrators, strong session secrets and production email logging
   off. Decide administrative MFA coverage across *all* available sign-in methods,
   breached-password checks and signup enumeration policy. Test CSP before moving
   report-only restrictions to enforcement. Finalise privacy/terms, retention,
   deletion, subprocessors and support contact. A clean dependency audit is not a
   security certification.

8. **Paid pilot and operational ownership.** Name the release/support owner,
   confirm provider and hosting budgets, complete restore/alert/capacity checks,
   and agree go/no-go thresholds for CV quality, failures, latency and spend.
   Start with a limited cohort after all release gates pass.

## Already built; validate rather than rebuild

Experience-based private company/role recommendations, career-record enrichment,
non-blocking persistent conflict review, role entitlements, tier editing budgets,
inline AI tools, staged CV editing, measured page fitting, execution manifests,
bounded retrieval and app-wide durable activity are implemented. Verify them in
the launch journeys above. Company promotion, neural embeddings, adaptive question
ranking and closed-browser push are deliberately deferred; they are not hidden
requirements for the accepted first release.

## Local verification for this cleanup

The ATS adapter suite passes 98 tests; provider selection/SDK tests pass 17;
readiness/configuration scripts pass 17. Core and AI typechecks pass. The production
dependency audit reports zero known advisories after the parser upgrade. These
checks are offline/fixture-based (apart from the read-only registry audit) and do
not substitute for the release gates above. No database migration is introduced
by this cleanup.
