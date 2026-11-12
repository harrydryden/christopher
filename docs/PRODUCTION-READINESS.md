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

Prefer qualifying the selected provider before the final model evaluations and end-to-end launch
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

3. **OpenRouter integration — selected.** Owner decision confirmed on 12 November
   2026: use OpenRouter for the multi-model CV harness. Munito is no longer a
   planned launch integration or required comparison. Provision the OpenRouter
   account, scoped credentials, processing-region policy, spend limit and
   data-processing terms. Engineering must implement the adapter and update
   health, pricing, capability routing and evaluation tooling. OpenRouter is not
   yet implemented; the existing Anthropic runtime remains in place until the
   replacement is qualified. Compare first-pass relevance, page fit,
   structured-output validity, completion latency and total cost including retries,
   reasoning tokens and platform fees against the existing baseline. Qualify
   extraction, drafting, review and inline edits separately, then canary with
   rollback. Do not silently send candidate data to an unapproved provider.
   See the decision below for routing and privacy requirements.

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

8. **Deep PostHog integration.** Establish a dedicated analytics, observability
   and controlled product-automation workstream. Owner: provision the project,
   choose hosting region, retention and spend limits, and approve consent/privacy
   requirements. Engineering: audit existing instrumentation and write a coherent
   integration ADR before implementation; verify current PostHog capabilities,
   SDKs and commercial limits rather than assuming every capability is included.
   The scope is:
   - Define a versioned event taxonomy and pseudonymous account identity across
     onboarding, imports, Experience enrichment, recommendations, applications,
     CV generation, Refine/Manual editing, finalisation and billing. Record actual
     server-confirmed outcomes; deduplicate retries and keep test/admin traffic
     distinguishable. Do not use analytics as the billing or entitlement ledger.
   - Build activation, conversion, abandonment, retention and cohort dashboards,
     plus CV time-to-first-draft, completion/failure rates, first-pass acceptance,
     editing effort and cost per completed CV. Correlate browser actions, queued
     tasks and model stages with opaque identifiers to explain delays and errors.
   - Assess error tracking, web performance, privacy-safe session replay and model
     observability alongside existing operational monitoring. Mask inputs and
     sensitive screens by default; never send raw CVs, career facts, uploaded
     documents, prompts/responses, credentials or payment details. Use allowlisted
     metadata, sanitised URLs/errors and tested consent/deletion behaviour.
   - Use feature flags and experiments for staged rollouts and measurable UX
     improvements. Define “self-driving” as detecting friction, proposing changes
     and running bounded, approved experiments first. Require outcome metrics,
     minimum evidence, guardrails, audit history, rollback and a kill switch before
     autonomous changes; never let analytics silently change CV facts, account
     access, prices or entitlements.
   - Keep capture asynchronous, bounded and failure-tolerant. Analytics outages
     must not block sign-in, editing, payment processing or CV generation. Set
     bundle, latency, sampling and ingestion-cost budgets and verify them.
   Exit evidence: validated event coverage and privacy tests, useful dashboards,
   correlation across a complete CV build, and a safe rollout/rollback exercise.
   Prioritise measurement and observability before the paid pilot; introduce
   autonomous optimisation only after trustworthy baselines and explicit approval.

9. **Production error monitoring — PostHog; Sentry deferred.** Use PostHog Error
   Tracking as the planned primary error-triage system and prove its coverage
   before paid launch. Do not add Sentry, its SDK or a second replay collector in
   this workstream. [PostHog supports exception capture and source maps](https://posthog.com/docs/error-tracking/start-here).
   If qualification exposes a material gap, record and address it explicitly;
   do not silently introduce another telemetry vendor.
   - Cover browser, server actions/routes and background workers, including
     handled terminal CV failures, exhausted retries and stalled queues. Tag
     release, environment and task stage; retain readable stack traces through
     private source-map upload and test correct release association.
   - Scrub before transmission: no career text, model payloads, auth tokens,
     cookies, request bodies or sensitive query strings in errors, breadcrumbs,
     traces or replay. Test the payloads actually sent, not only SDK settings.
     Keep replay in PostHog with the privacy rules above.
   - Route actionable alerts to a named owner; distinguish new regressions from
     expected validation failures. Bound sampling/cost and SDK overhead, and test
     provider outages without blocking product flows. Include independent uptime
     and queue-heartbeat checks: an exception tracker cannot report a dead process.
   Exit evidence: deliberately trigger a browser error, server error and worker
   failure in staging; receive a deduplicated alert, identify the responsible
   release/stage from sanitised data, and prove recovery. Error monitoring does
   not replace preventive security controls or security-event auditing.

10. **Security tooling and development before launch.** Turn item 7's security
    review into an owned backlog with tests and launch-blocking findings. Use
    [OWASP ASVS](https://asvs.owasp.org/) to scope verification of this application;
    do not claim certification merely from running scanners.
    - Inventory existing controls first. Enable automated dependency alerts and
      updates, PR dependency review, secret scanning/push protection and static
      code analysis (CodeQL or an appropriate alternative). Check private-repo
      licensing; use maintained CI alternatives where needed. Add worker image
      scanning, least-privilege workflow tokens and pinned third-party actions.
      [GitHub documents these security capabilities](https://docs.github.com/en/code-security/getting-started/github-security-features).
      Assign remediation owners, required checks and time-bounded exceptions;
      triage existing findings as well as newly introduced ones.
    - Verify and harden authentication, account linking, session invalidation,
      administrator access and every tenant boundary. Test rate limits and abuse
      budgets on signup, login, reset, imports, AI generation and webhook routes.
      Ensure enforcement works across instances; do not rely on browser controls.
    - Exercise URL-import SSRF and redirect/DNS protections, upload type/size and
      decompression limits, parser isolation/timeouts, sanitised HTML/PDF output,
      private download authorisation and untrusted document/prompt boundaries.
      Add missing guards and regression tests found by this review; evaluate
      malware scanning/quarantine against actual upload processing and retention.
    - Test webhook signatures/replay handling and ledger idempotency; prevent
      cross-account credit or entitlement changes. Validate secret rotation,
      privileged-action audit records, account/data deletion and least-privilege
      database/storage access. Security logs must remain available independently
      of optional product-analytics consent, under a documented retention policy.
    - Configure and test hosting firewall/rate-limit protections, HTTPS/security
      headers and CSP. Run an authenticated staging vulnerability scan and an
      independent focused penetration test, covering business logic scanners miss.
      Keep active scanning off production until explicitly scoped and approved.
    - Document incident ownership, credential revocation, breach assessment,
      recovery and vulnerability reporting. Rehearse one incident before launch.
    Exit evidence: no unresolved exploitable critical/high findings; lower-risk
    findings have explicit owners and deadlines; security regression checks pass,
    independent review findings are retested, and alert/recovery drills succeed.
    Buying a security tool alone does not satisfy this gate.

11. **Paid pilot and operational ownership.** Name the release/support owner,
   confirm provider and hosting budgets, complete restore/alert/capacity checks,
   and agree go/no-go thresholds for CV quality, failures, latency and spend.
   Start with a limited cohort after all release gates pass.

## OpenRouter — accepted provider decision, 12 November 2026

The owner has selected OpenRouter because the application is a model harness:
we need to compare and select models per task without reworking product flows.
The comparison below records the rationale; Munito is not part of the launch
build plan. This decision authorises the integration direction, not an unqualified
production cutover. Neither vendor was benchmarked by this review; no speed or cost
advantage is claimed without application-specific measurements.

| Consideration | OpenRouter | Munito | Implication for this application |
| --- | --- | --- | --- |
| Model choice | Broad multi-provider gateway | Focused open-model inference catalogue | OpenRouter offers more room to optimise each CV stage and retain a strong quality baseline |
| Reliability | Configurable provider routing/fallbacks | Direct regional inference service | Gateway failover is useful only between explicitly qualified endpoints; neither removes our need for checkpoints/retries |
| Privacy and residency | Policies span the gateway and downstream providers; regional routing is plan-dependent | Explicit EU endpoint and no prompt/output retention by default | Verify contracts, subprocessors and actual routes; do not infer privacy from API compatibility |
| Cost | Model charges plus platform fees | Published model/region/service-tier prices | Compare cost per accepted CV, including retries and editing, rather than token price alone |
| Integration | Adapter, capabilities, usage reconciliation and routing policy required | Adapter, capabilities and usage reconciliation required | Neither is a key-only replacement for our current Anthropic runtime |

Current official sources: [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[pricing](https://openrouter.ai/pricing), [data handling](https://openrouter.ai/docs/guides/privacy/data-collection),
and [Munito's regional, model and retention documentation](https://docs.munito.ai/faq).
OpenRouter currently lists 5.5% Standard and 8% Business platform fees; EU in-region
routing is listed for Business/Enterprise. Recheck commercial terms at procurement.
Munito's EU endpoint addresses inference locality; this is not a claim that every
account/billing service or network hop stays in the EU.

For OpenRouter qualification:

- Pin model identities and an approved provider/endpoint allowlist per stage;
  disable unconstrained automatic model selection and fallbacks. Record actual
  model/provider, route policy version and usage in execution manifests/journals.
  A pinned route improves repeatability but does not promise identical model text.
- Require supported parameters (`require_parameters: true`), validate returned
  schemas locally, and fail closed if privacy/capability constraints leave no route.
  Use explicit no-collection/ZDR policies where available and verify their contract
  scope. Keep input/output logging and product-training opt-ins disabled. Review
  documented legal/safety retention exceptions; do not promise absolute zero retention.
- Bound retries across our worker and the gateway to avoid multiplicative latency
  and spend. Measure queue time, first token, full response and completed CV p50/p95;
  test cancellation, streaming failures, throttling, accounting and route outages.
- Benchmark selected OpenRouter models against the existing quality baseline
  using the same synthetic or consented fixtures. Establish pass thresholds before
  comparing. Keep customer credit entitlements independent of provider bills.

Stripe announced an **agreement to acquire** OpenRouter on 19 August 2026. That
supports strategic alignment, but this review has not independently verified a
closing announcement. Do not assume shared credentials, billing contracts,
privacy terms or automatic compatibility with our Stripe subscriptions. Source:
[Stripe announcement](https://stripe.com/newsroom/news/stripe-agrees-to-acquire-openrouter).

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
