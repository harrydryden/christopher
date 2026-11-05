# Course of Life: production plan

Date: 5 November 2026. Baseline: `96201a08`, including merged authentication PR #137.
This is the current forward plan; the October paid-launch review is historical evidence, not a
certificate for this release. Items below remain open until their acceptance evidence is attached
to the exact release commit. No provider, payment or domain switch is performed by this review.

## Launch sequence and ownership

| Order | Work | Owner / input | Exit condition |
| --- | --- | --- | --- |
| 1 | Merge and verify the auth/onboarding corrections | Engineering | CI, hosted browser acceptance and migration status green for the candidate; no lost account, document or destination |
| 2 | Finalise visual design and test the two entry journeys | Design + product owner + representative users | Mobile/desktop sign-off; people can start without instructions and recover from failures |
| 3 | Implement and qualify Munito | Engineering + owner-provisioned inference account, region and budget | Provider contract tests, fresh CV evaluations and cost/latency comparison pass; rollback rehearsed |
| 4 | Add Experience-based recommendations | Engineering + product owner | Empty-company accounts get grounded suggestions; existing preferences remain authoritative; quality evaluation passes |
| 5 | End-to-end CV and payment acceptance | Engineering + pilot users + owner-managed Stripe test account | Saved words, layout, final artefacts and money/credit ledger reconcile through success and failure |
| 6 | Security, operational and domain readiness | Engineering + independent security reviewer + DNS/provider administrators | Security findings resolved, recovery/alerts proven, canonical domain and real sign-in round trips work |
| 7 | Limited paid pilot, then expand | Product/release owner | Explicit go/no-go; controlled live purchase/refund; monitored activation, CV quality, spend and support |

Stages 2–5 can overlap; repeat final end-to-end tests on the chosen model, design and domain.
Do not launch a promise of Experience-based recommendations before stage 4 ships. If it is
deliberately deferred, remove that promise and record the changed launch scope.

## 1. Auth and initial onboarding acceptance

The [auth and onboarding review](AUTH-ONBOARDING-REVIEW-2026-11-05.md) records the implementation.
Retain two independent starting jobs: **find roles** (preferences → follow → results) and
**build for a role I have** (add advert → prepare Experience → CV). Importing Experience is also
directly available; it is never a prerequisite for monitoring companies.

- [ ] Set a strong server-only session secret, explicit administrator addresses, canonical
  `APP_URL`, and a verified transactional sender. Turn off production auth-link logging.
- [ ] Check SPF, DKIM and DMARC with the email provider; test confirmation and reset delivery,
  spam-folder behaviour, resend, expiry and another-device confirmation. Review delivery and
  bounce telemetry without storing tokens or document content.
- [ ] Configure Google callback/consent and complete Gmail, Workspace and external-email proof
  journeys. Confirm the same account, history and credits after changing sign-in methods.
- [ ] Create the LinkedIn developer application, obtain the OpenID Connect product and configure
  credentials/callbacks using [LinkedIn setup](LINKEDIN-SIGN-IN.md). Test missing email, different
  email, explicit linking, cancellation and disconnect. Keep its button absent until configured.
- [ ] Verify that sign-in does not claim to import a LinkedIn career history. Test own-profile PDF
  instructions → upload → review → save, alongside CV, DOCX and pasted text.
- [ ] Test closed registration, a newly unverified member, a pending administrator, fresh proof
  for linking/password enrolment, session revocation and safe return paths.
- [ ] On slow/offline connections, double click, navigate back, refresh and retry. Preserve input
  and the destination, provide an accurate status, and never create duplicate imports or credits.

One normalised email has one account; a provider subject belongs to one account. Different email
addresses cannot safely be recognised as the same person without explicit account proof. Do not
promise automatic cross-email deduplication or merge accounts by name/photo.

## 2. Final visual design

- [ ] Approve the Course of Life wordmark, favicon/app icons, colour tokens, type hierarchy,
  spacing, focus rings and button hierarchy. Use the same components for auth and product forms.
- [ ] Approve desktop and narrow-phone layouts for sign-in, confirmation, first-use choices,
  import review, Roles, Applications, Account/billing and all three CV modes.
- [ ] Standardise empty, pending, success, recoverable failure and unavailable states. Give one
  primary next action; put advanced settings and diagnostic detail behind appropriate controls.
- [ ] Finalise visible CV/PDF templates: contacts beside name, no summary heading, Experience
  heading, aligned industry labels, compact/reorderable skills and Education/Training/Interests.
  Check long names, long employers, accented characters, hyperlinks and page breaks.
- [ ] Verify contrast, keyboard order, accessible labels/help/errors, 200% zoom, reduced motion,
  password-manager/autofill and paste support. A pending button must announce progress without
  moving focus or clearing the typed password.

Use [WCAG's accessible-authentication guidance](https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html)
for the sign-in/recovery checks. Automated accessibility scans supplement keyboard and screen-reader
testing; they do not replace it.

## 3. UX testing and speed

Run a first moderated round with 5–8 people across new graduates, experienced applicants and career
changers. Include phone use and someone unfamiliar with AI products; include assisted-technology
testing. This is a discovery round, not a statistically representative conversion claim.

Give tasks without explaining the interface: create an account; recover access; import a CV;
correct a mistaken import; find/follow an employer; add an existing advert; build a CV; refine it;
make a final manual edit and download; buy credits; return a day later. Observe rather than coach.
Record completion, wrong turns, assistance, time to first useful result and whether the person can
explain what was saved and what a rebuild will retain. Prioritise any data-loss, misleading-save,
accidental-payment or account-duplication confusion as a release blocker. Retest the changed flows.

Proposed performance gates, to be measured rather than assumed:

- Visible acknowledgement on submit within 100 ms under normal local interaction.
- Field-page Core Web Vitals targets at p75: LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1. Capture device and
  connection mix; synthetic checks are regression signals, not proof of field performance.
- Save a text-only draft with **no AI or full rebuild**; measure p50/p95 and target p95 ≤2 s on
  the hosted pilot. A saved result must survive navigation/reload.
- CV/import jobs acknowledge queuing promptly, show the real stage, tolerate tab closure and
  resume with a visible result. Record queue wait separately from model and PDF time. Set a
  customer-visible duration expectation from pilot percentiles, not an invented countdown.
- Poll only while work is active; check background tabs, failure backoff and no duplicate refresh
  after a server action. Preserve server rendering and avoid shipping provider/DB code to clients.

## 4. Switch from Claude to Munito

**Not implemented or enabled in this review.** The existing AI engine is built around the Anthropic
SDK, Claude model capabilities, pricing, model-access checks and Message Batches. Changing a key
alone is insufficient.

Munito documents an Anthropic-compatible Messages API and an OpenAI-compatible API. For the
Anthropic SDK its EU base URL is `https://api.eu.munito.ai/inference` (without `/v1`); OpenAI uses
`https://api.eu.munito.ai/inference/v1`. Model IDs must come from its catalogue. Unsupported
parameters may return HTTP 400. These facts are from the [compatibility guide](https://docs.munito.ai/compatibility)
and [regional endpoint guide](https://docs.munito.ai/faq), checked 5 November 2026; recheck at cutover.

Implementation order:

1. Owner creates a separately scoped test inference key, agrees region, service tier, spend limits,
   data handling and support arrangements. Put secrets in deployment settings, never browser
   configuration. Use synthetic or consented/redacted evaluation records first.
2. Introduce a small provider adapter and capability contract at the existing `AiClientLike`
   boundary. Centralise endpoint/key/model selection for web and worker. Keep prompt validation,
   account budgets, queue leases and evidence provenance independent of the provider.
3. Explicitly test structured JSON, streaming event/usage parsing, token counting, cancellation,
   maximum output, reasoning-only/empty answers, refusals, throttles and error translation. Do not
   forward Claude effort, beta fallback or cache controls without verified support. Do not assume
   an Anthropic model-retrieve or Messages Batch API exists; use tested alternatives or disable
   those capabilities and exercise the existing individual-call path.
4. Register provider/model/region and current token pricing in the cost ledger, holds, spend
   reports, health probes and evaluation identity. Avoid a model-only cache/breaker key that lets
   one provider's failure or saved result contaminate another's. Reset/invalidate appropriate
   routing caches on change; retain historic spend as recorded.
5. Compare candidate models on the same representative imports, role requirements, planning,
   writing, assessment, skills and recommendations. Record factuality, unsupported claims, schema
   failures, preference adherence, page fit, latency and **cost per completed CV**, including
   retries. Have users judge the final documents; select by evidence rather than catalogue size.
6. Preserve bounded retries and the application's single retry authority. Munito documents that
   inference POST retries are new billable requests, not idempotent replays. Poll an existing
   background request rather than creating another; do not retry account spend-cap failures.
   See its [production checklist](https://docs.munito.ai/production-checklist).
7. Qualify the exact provider/model/prompt combination with fresh live reports, update release
   gates and launch-config validation, canary to test accounts, then approved pilot traffic. Keep
   the last qualified configuration available for an explicit rollback; do not silently send CV
   data to an unapproved fallback provider. Revoke unused keys after a stable cutover.

## 5. Experience-based company and job recommendations

**New feature, not yet implemented.** Today `handleSuggestCompanies` requires followed companies
and supplies their profiles plus preference/feedback context. `findMoreSuggestions` also refuses
an account with no followed companies. This leaves the new user with rich Experience but no follows
without a starting recommendation.

Extend that pipeline rather than introducing another recommendations page:

- Derive an account-private, versioned recommendation profile from **confirmed** Experience:
  skills, responsibilities, seniority, industries and evidence-backed outcomes. Exclude contact
  details, unaccepted imports, draft/unconfirmed claims and inferred protected characteristics.
- Preserve explicit desired roles, location/remote choices, exclusions and dismissed companies
  as constraints. Experience describes capability, not permission to override what the person
  wants next. Provide a simple choice to use Experience and the ability to disable it.
- Permit a cold start when confirmed evidence exists, even with zero follows. With neither
  evidence nor preferences, show a choice to add Experience or set preferences; do not invent a
  profile. With preferences only, keep the current route working.
- Reuse verified company candidates, canonical domain deduplication and catalogue/follow actions.
  A model-suggested employer is a candidate until verified. Job recommendations use real stored
  postings, current source links and availability; do not invent vacancies or imply LinkedIn jobs
  access. Surface roles outside followed companies as suggestions, not automatic subscriptions.
- Show a concise “Why this match” tied to evidence and preferences, with dismiss/change controls.
  A fit score is guidance, not a promise of interview likelihood. Following/applying stays explicit.
- Recompute asynchronously only when relevant confirmed evidence/preferences change; deduplicate
  by account + input versions + model/prompt. Serve the last result with an updating status and
  never let an older task overwrite a newer profile. Delete derived data with the account.

Acceptance: zero-follow cold start; preference-only fallback; conflicting evidence/preferences;
archived/deleted evidence; changed location; duplicate companies; rejected matches; unavailable
jobs; budget exhausted; stale tasks; and two-account isolation. Add human-labelled relevance tests
across career paths and compare with the existing preference-only baseline. Expose no private
evidence in the shared company catalogue.

## 6. End-to-end testing, especially the CV builder

Use fresh test accounts and realistic documents, not existing customer records. Cover Chrome,
Safari and a narrow mobile viewport. Keep a source fixture, expected facts and downloaded PDF for
each case. Test both browser actions and persisted records, not just visible success messages.

| Journey | Evidence required |
| --- | --- |
| New account → confirmation → CV/DOCX/LinkedIn PDF import → review | One account; no model work before required verification; exact accepted items only; no duplicated evidence after retry |
| No document → manual Experience → role | No dead end or unnecessary monitoring prerequisite |
| New role → ranked priorities → Auto | Evidence-linked content; essentials and user order respected; reproducible build inputs and sensible coverage |
| Refine → update underlying Experience → rebuild | Role-specific choices retained and visible; reset-one/reset-all work; omitted evidence stays omitted |
| Manual → save → reload → finalise/export | Exact wording retained in saved final version; no AI during text-only save; rebuild-loss warning accurate |
| Skills and supporting sections | Generate/select/save to library; reorder sections/items; edit headings; up to five sections; dynamic Education/Training/Skills/Interests heading |
| One/two/three-page layouts and font changes | Actual rendered PDF respects generation limit, uses available space, preserves priority evidence and has aligned pills/links; manual-overrun override recorded |
| Warnings and new evidence | User can acknowledge editorial findings/finalise; genuinely new user facts can be added to Experience; invented model claims do not silently become confirmed facts |
| Interrupted work | Close tab, refresh, worker restart, provider 400/429/5xx, budget limit, queue outage and retry preserve committed work; no stale status forever or duplicate credit charge |
| Finalise → download/share/apply | Final PDF matches selected revision; scoped share expires/revokes; application points to correct frozen artefact |
| Concurrent tabs/accounts | Obsolete edits rejected without erasing text; cross-account IDs fail; no inherited settings, documents, recommendations or credits |

Separate deterministic tests, live model evaluations and human quality acceptance. All three are
needed; an older saved evaluation or a synthetic provider does not qualify the new Munito path.

## 7. Stripe billing

Follow [billing setup](BILLING-SETUP.md) for the six configured GBP Prices, nine webhook events and
Portal settings. Confirm current pricing/tax/business terms with the owner; this plan changes none.

- [ ] Configure test Prices, keys, webhook signing secret and Portal. Apply **all checked-in
  migrations for the candidate**, including identity migrations; do not stop at a historical number.
- [ ] Run offline configuration and read-only catalogue checks in test mode. Verify an actual
  signed event reaches the handler without a browser cookie, and bad signatures change nothing.
- [ ] Buy each plan/top-up, renew, fail/recover renewal, cancel/change capacity, refund and dispute.
  Replay and reorder webhooks. Reconcile Stripe, entitlements and credit ledger, including admin
  gifts, concurrent CV builds and no-charge failures. A return-to-site URL never proves payment.
- [ ] Confirm invoices/receipts, displayed totals, support/refund path, account deletion and
  in-flight Checkout handling. Prevent cancellation/deletion leaving unnoticed future charges.
- [ ] Configure live mode separately, run live checks, then conduct one owner-approved controlled
  purchase/cancellation/refund. Keep test and live identifiers separate and document rollback.

## 8. Switch the domain to courseof.life

1. Verify domain ownership and DNS access; choose `https://courseof.life` as canonical, with `www`
   and the old hostname redirecting appropriately. Add it to hosting and prove TLS before cutover.
2. Configure web/worker origins, Google and LinkedIn authorised callback URLs, emailed confirmation
   and reset links, Stripe webhook/Checkout/Portal return URLs, shared-CV links, health checks,
   release variables, analytics and legal/support links. Do not rely on redirects for OAuth or
   webhook POSTs. Register the exact new endpoints at each provider first.
3. Verify the transactional email domain separately. Make a staging rehearsal of sign-in,
   confirmation, reset, payment, share and PDF/download on the new hostname.
4. Host-scoped cookies do not move between domains: explain that users must sign in again, but
   keep the same database/account IDs and credits. Leave enough time for in-flight OAuth attempts
   and already-sent email links; ensure old share/verification links preserve path and query under
   the agreed redirect policy and remain subject to their existing expiry/revocation.
5. Switch DNS/canonical origin, verify TLS and all provider flows, monitor errors, then retire old
   callbacks/webhooks only after traffic drains. Avoid duplicate billing fulfilment during overlap.
   Keep a documented DNS/origin rollback and retain the old domain while old customer links exist.

## 9. Security and operational hardening

- [ ] Commission an independent authenticated review against an OWASP ASVS-based test plan:
  account takeover/linking, recovery replay, CSRF, session revocation, horizontal/vertical access,
  shares, import races, SSRF, malicious PDFs/DOCX, stored XSS and model prompt injection.
- [ ] Resolve the deliberate signup-email enumeration trade-off (existing-account notice) before
  public registration; test timing/rate-limit behaviour and decide whether neutral signup recovery
  should replace it. Do not weaken current proof checks to improve conversion.
- [ ] Enforce MFA/passkeys or equivalently protected privileged access for production operators;
  the application currently has no native MFA. Include recovery/break-glass arrangements, not
  just a second-factor prompt. Minimise administrator membership.
- [ ] Strengthen new-password policy before public registration: the current minimum is ten
  characters and there is no compromised-password check. Adopt a longer passphrase minimum for
  password-only access and a privacy-preserving common/compromised-password check, with accessible
  guidance and password-manager support. Preserve existing sign-in compatibility; do not force
  arbitrary periodic changes or introduce composition rules that make passwords harder to use.
- [ ] Audit/upgrade dependencies against current advisories, scan secrets and review token/PII
  log redaction and retention. Review the remaining report-only script CSP and implement/test
  enforcement without breaking Next.js hydration, uploads or the PDF preview.
- [ ] Run abuse, upload-limit, parser-limit and queue/budget load tests; monitor distributed
  throttles and false lockouts. Verify forwarded-address trust at the hosting boundary.
- [ ] Enable required CI/review/branch protections and a release promotion gate; verify the
  deployed web and worker identities for the exact candidate. Inspect actual configuration rather
  than assuming old repository/hosting settings are unchanged.
- [ ] Prove backup restoration in isolation, alert delivery to a named owner/backup, worker restart
  recovery, capacity and memory headroom. Recheck historical slow 100-session bursts and monitoring
  cadence findings rather than treating them as current measurements.
- [ ] Approve privacy/terms, subprocessors (including Munito), retention/export/deletion handling,
  support and incident response with the responsible owner. Do not equate EU hosting with an
  automatic compliance conclusion.

Guidance: [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
and [Stripe webhook verification](https://docs.stripe.com/webhooks). No live penetration test,
provider credential validation, DNS change or payment has been carried out by this review.

## Final go/no-go record

Record commit, migrations, provider/model/prompt identities, CI, browser and live evaluation links,
human acceptance, security findings/exceptions, measured performance, Stripe reconciliation,
domain/email checks, alert/restore evidence and rollback owner. Start with a capped pilot and review
activation, confirmed imports, completed CVs, failed/retried work, support requests and cost per
successful CV. Expand only after the release owner accepts the evidence.
