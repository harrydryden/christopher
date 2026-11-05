# Auth and initial onboarding: integrity and UX review

Date: 5 November 2026. Baseline: `96201a08`, after PR #137.

The previous [authentication audit](AUTH-REVIEW-2026-11-04.md) addressed credential races, session
rotation, provider ownership and throttling. This review follows what a new member actually does:
sign in/create → confirm → choose a starting job → provide evidence or a role → see a usable
result. It also follows recovery, cancellation, resubmission and competing tabs. This is source,
automated and local browser verification; it is not a live-provider or independent penetration test.

## Journey and state decisions

| User job / state | Primary action | Integrity rule | UX simplification |
| --- | --- | --- | --- |
| Return to an account | Sign in using an existing method | Recheck live credential/subject at session publication; never merge by name | Same pending-submit control across auth forms; preserve requested destination |
| Create an account | Email/password or configured provider | One normalised email; one owner per provider subject; current registration policy | Optional name stays optional; user-facing unavailable messages contain no server configuration |
| Confirm email | Open link, prove account and confirm | Inert GET; single-use POST; fresh token/account binding | Explain delivery state and return to the requested task; expose resend before billing |
| Recover access | Request a new link / set password | Generic public response, throttles, single use, revoke old sessions | Invalid link exposes recovery action rather than a form that cannot succeed |
| Link LinkedIn/Google | Prove existing account and explicitly link where required | No automatic cross-email account merge, no extra welcome credits | Sign-in copy does not claim career/profile/connection import |
| Start monitoring | Preferences → follow company → first complete scan | Email/gate checks; canonical shared catalogue, private subscriptions | First-use choice and one next action; full checklist secondary |
| Bring an existing role | Add advert → prepare evidence → CV | No requirement to follow companies just to build a CV | A direct, equally visible start |
| Prepare Experience | Import a document or enter history | Ownership, bounded formats/URLs, anchored proposals | Import/manual choice visible without reading setup documentation |
| Document queued/reading | Wait, leave safely, or recover stalled work | Import and queue entry commit together; active work deduplicated | Accurate reading state; reupload can recover an old stranded import |
| Review extracted evidence | Select items and save | Current displayed proposal identity and Library version checked under locks | If first import needs a name, enter it at acceptance rather than save another form first |
| Retry/dismiss/accept in competing tabs | Refuse obsolete action; reload | Dismissed or replaced proposals cannot write to Experience | Actionable stale-state message; no silent reinterpretation of checked positions |

There is no new compulsory onboarding wizard or duplicate stored “step” state. Existing account,
verification, preferences, subscriptions and Library records determine progress. Experience is
optional for monitoring. Queued work, failure and a successful empty result remain different states.

## Findings and implementation

| Finding | Impact | Correction |
| --- | --- | --- |
| Import/reopen commits before enqueue | A queue failure leaves a document apparently reading indefinitely | Use the same transaction/writer for import and queue creation; recover existing unread rows without active work |
| Acceptance trusts a proposal read before the transaction | Dismiss/retry in another tab can still admit obsolete evidence | Lock the owned import; validate current proposal and successful resolution with the Library version write |
| Old form's item IDs refer to a changed extraction | A retry can make selected positions refer to different facts | Include a hash of the displayed completed proposal and compare under lock; missing/mismatched keys fail without a Library write |
| Optional signup name becomes a later import blocker | Paid extraction ends in an unrelated “save your name first” detour | Accept an explicitly entered first-Library name in the same save; never infer it or overwrite an existing Library name |
| Email provider fetch has no deadline | A newly created account can hang while sending mail | Bound transport, reject redirects and cancel unread response bodies; return an explicit failure outcome |
| Signup ignores delivery result | Interface says a link was sent when none was | Show recoverable owner-visible delivery failure; public resend remains non-enumerating |
| Pending signup/verification drops the destination | A user brought by a CV/role deep link lands elsewhere | Carry a sanitised local `next` through email/form/error paths; default to the existing Account success route |
| Registration setting can change during password/OAuth work | A registration may proceed after the switch was closed | Password, Google and LinkedIn share a current-policy reader on the held connection; the creation/policy-write fence serialises the decision; existing subject sign-in remains available |
| Auth forms give no in-flight feedback | Duplicate submission and uncertainty on slow connections | One small shared client submit control; server-rendered forms and fields remain, with pending label and live status |
| Public pages expose session-secret/log/deployment instructions | A customer gets an operator task they cannot perform | Neutral unavailable/recovery wording; operational setup stays in documentation/admin surfaces |
| First-use guidance repeats the next action and hides Experience | Extra reading before the person can start | Two clear starting jobs, direct Experience link and manual-entry jump; detailed checklist remains expandable |
| A completely new Roles landing renders empty filters/tables below setup | Competing controls and a repeated preferences action | Hide the unused workspace only for the unfiltered root with no roles or companies; explicit views and existing data keep all controls |
| Email confirmation is subordinate to purchase UI | Unverified users are invited into unrelated billing before required setup | Make confirmation/profile action precede billing; preserve return intent on resend |
| Email notice disagrees with checklist next step | Setup suggests filters/follows while verification is blocking | Give email confirmation precedence in the derived notice |
| Reset/confirmation URLs lack specific referrer/cache policy | Sensitive URLs can propagate to same-origin requests/caches | `no-referrer` and `private, no-store` across auth, login/signup and reset/forgot pages |
| Stripe callback is stopped by browser-cookie middleware | Real payment events cannot reach their signature handler | Only the exact webhook path bypasses cookie checking; Stripe signature remains the authority; neighbouring paths remain protected |
| Offline launch check misses partial OAuth and implicit admin defaults | A deploy can look ready while sign-in is broken or privileged ownership implicit | Validate complete optional provider pairs, explicit admin list, sender and canonical public hostname; print no values |
| Production dependency audit reports newly disclosed critical/high advisories | Framework/server actions, validation and transport dependencies need current fixes | Upgrade Next to 15.5.28, Zod to 4.6.6, Undici to 7.30.1 and qs to 6.16.1; preserve the existing Next hydration patch on the patched version |

The proposal hash is a stale-view guard, not an authentication token. Ownership checks, document
anchoring and version locks remain required. Import retries do not promote unreviewed facts into
confirmed evidence. No database migration is introduced by this review.

## Boundaries retained

- Password/session proof, Google authoritative-email rules and LinkedIn explicit linking from
  PR #137; exact provider subject is still the identity for returning linked users.
- Confirmation/reset GETs do not consume tokens. Provider code/state checks, one-use browser-bound
  LinkedIn continuation and safe redirect sanitisation remain in place.
- Server and worker both validate uploaded documents. The worker has expansion/parser limits;
  website imports reuse the bounded fetcher, DNS/private-network and URL guards. A model's output
  is a proposal anchored to source text, never an instruction to execute.
- Account-scoped reads/actions and shared-catalogue separation; billing signature verification and
  idempotent ledger writes. User acknowledgement of CV editorial warnings is not an auth bypass.

## Performance and implementation choices

Auth screens remain server components; only the reusable pending button adds client behaviour.
No new dependency, framework, global cache of session authority or onboarding-state table is
introduced. Existing request-local auth memoisation and indexed live session reads remain. Import
queue work commits on the held connection rather than adding another pool checkout inside a
transaction. Email waits are bounded, and external calls do not hold account/import locks.
Account confirmation streams before the separately loaded billing panel, so a plan/capacity lookup
does not delay the initial email action. First-use Roles avoids rendering the unused table/filter
controls and the extra empty-result setup read; it reuses facts already loaded for that workspace.

These are bounded-resource and round-trip improvements, not a measured production speed-up.
Collect field metrics and journey timings on the actual hosted release as set out in the
[production plan](PRODUCTION-PLAN-2026-11-05.md).

## Verification record

Relevant checks include actual database-backed import races and rollback, stale view and account
isolation, auth/recovery actions, registration policy changes, email failure/timeouts, UI
rendering/pending behaviour, safe destinations, and middleware-to-signed-Stripe-handler flow.

- Web: 1,924 tests across 219 files; core: 811 tests across 57 files; AI: 208 tests across 12 files.
- Worker document text, fetcher and Library-import suites: 100 tests across four files, including
  parser/input limits and private-network URL refusals. Model calls in these tests are simulated.
- Release scripts: 149 tests passed, with two opt-in checks skipped; this includes the ten offline
  launch-configuration tests. All package type checks, the production Next build and worker build
  passed with the updated dependencies and retained hydration patch.
- The existing verified evaluation-report gate passes for the unchanged prompt set. This checks
  committed evidence; it is not a new live model run or qualification of Munito.
- Local production-browser checks used a synthetic account and isolated PostgreSQL database:
  email/password sign-in displayed its pending state and preserved the requested Experience
  destination; a pasted document created exactly one import and queued task; the first-use Roles
  page showed the two starting choices without empty controls; an invalid reset link exposed only
  the recovery path. The actual reset response returned `no-referrer` and `private, no-store`.

The browser import stopped at queuing because no live model worker was run. Email, identity and
model simulations do not establish real provider availability. A stale monitoring-notice
expectation was corrected to assert email confirmation first, then monitoring state once verified.

`pnpm audit --prod` reported zero known vulnerabilities after the targeted dependency updates on
5 November 2026, compared with 1 critical, 7 high and 5 moderate findings before. The existing Next
hydration patch applied to 15.5.28. This is an advisory database result, not proof of exploitability
before the change or absence of undisclosed vulnerabilities after it. Relevant advisories include
[Next server actions](https://github.com/advisories/GHSA-p3m5-59mp-jv5r),
[Next image optimisation](https://github.com/advisories/GHSA-2464-fhr4-w9xw),
[Zod collection limits](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and
[Undici redirects](https://github.com/advisories/GHSA-4w7w-5xrc-9h26).

Before release, complete hosted email, Google and LinkedIn round trips and the human/CV acceptance
matrix. LinkedIn still needs the developer app described in [setup](LINKEDIN-SIGN-IN.md). The Munito
switch, recommendation feature, Stripe configuration and domain move are tracked as pending in the
production plan rather than implied complete by this review.

## Remaining risks and decisions

- Public signup reports an existing email. Rate limits constrain enumeration, but the disclosure
  is still a trade-off; decide a neutral recovery/signup policy before open registration.
- No native MFA/passkeys for privileged accounts. Decide and prove production administrator
  protection and recovery; provider MFA alone does not constrain an alternate password path.
- The current password minimum is ten characters with no compromised-password check. Strengthen
  new-password enrolment/reset policy before public registration; this review preserves existing
  password compatibility rather than changing that product policy silently.
- Script CSP is still report-only. Test enforceable policy, dependencies, malicious document
  inputs and access boundaries independently; no claim of exhaustive security certification.
- Lost mail/expired tokens, closed registration and unavailable providers need a functioning
  support route with an accountable operator, not just clearer wording.
- UI tests and synthetic fixtures do not replace phone/browser/accessibility sessions with real
  applicants, nor live model quality and payment reconciliation.

Review principles follow [OWASP authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
and [WCAG accessible authentication](https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html).
