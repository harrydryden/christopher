# Authentication robustness and performance review

Date: 4 November 2026. Baseline: merged PR #136 (`d30b06d1`).

Scope: password registration and sign-in, Google and LinkedIn, provider linking and disconnect, email confirmation, password reset/change/enrolment, administrator account capabilities, session publication and revocation, distributed throttling, and failure latency. This review uses source inspection and local automated verification. It does not establish real-provider approval or successful hosted LinkedIn authorisation.

## Findings addressed

| Condition | Correction | Verification |
|---|---|---|
| LinkedIn registration holds a transaction connection, then asks the global pool for registration settings. Concurrent requests can exhaust a small production pool. | Read current registration policy through the held transaction. | Email proof and three registrations complete with a single-connection pool. |
| A password or linked provider is revoked after authentication is checked but before a session is inserted. | Publish sessions through one proof-aware method; lock the account, recheck the exact proven password hash or linked provider subject, then insert. | Reject stale password/provider proofs and preserve revocation after concurrent changes. |
| Password change leaves the same current cookie valid, including a copied cookie. | Revoke every old session and publish a replacement from the newly proved password. | The old cookie and other browsers are rejected; the replacement works. |
| A password rehash or change overwrites a concurrent reset. A later role update can also return a different hash from the one originally proved. | Conditional rehash and locked hash comparison; carry the proven hash separately from subsequently refreshed user data. | Stale snapshot and overlapping recovery regressions. |
| Concurrent Google callbacks contend for the same subject while seeing different email addresses. Ignoring an insert conflict can return the wrong account. | Recheck subject ownership under the identity fence; create the account and provider association atomically. | Same-subject races preserve a single subject owner. |
| LinkedIn linking trusts a password proof from a cached account snapshot. | Compare its proven hash to the locked current account and read the live session after the account lock. | A changed hash cannot attach a new provider. |
| Concurrent reset-link issuance can leave two current links; credential changes can race issuance. | Serialise issuance with account recovery and retire earlier links in the same transaction. | Concurrent issuance, reset and token-retirement checks. |
| A long-lived passwordless session enrols a permanent password without recent provider proof. | Require recent authentication through an existing provider and offer a direct reauthentication path; throttle all credential changes before costly hashing. | Old sessions are rejected; fresh linked-provider sessions can enrol a password. |
| A demoted administrator completes a delayed role change or generates another account's reset capability. | Recheck administrator authority inside the same fenced transaction as the privileged write. | Demotion barriers prevent the delayed capability/write. |
| LinkedIn email verification uses a separate mailbox quota from reset/confirmation. | Reuse the common mailbox and sender limits. | Exhausted shared quota blocks another LinkedIn verification email. |
| Sequential quota counts add database round trips to sign-in. | Batch window counts while preserving ordered advisory locks and atomic insertion. | Three quotas use at most five work statements, compared with seven previously; mixed windows and overlapping concurrent reservations retain their limits. |
| Public Google callbacks with valid signed state can repeatedly spend provider requests. | Apply the shared sender quota before provider exchange, retaining failures and releasing successful reservations. | Invalid state performs no quota/provider work; an exhausted quota blocks exchange. |
| Google requests can wait indefinitely or accept an unexpectedly large/malformed response. | Bound provider calls by time and response size, reject redirects and validate returned fields. | Provider failure and payload validation tests. |

Signed Google OAuth cookies also decode their JSON as UTF-8, preserving international role/filter return paths. IPv6 localhost cookie classification is covered by a regression.

## Performance boundaries retained

Normal authenticated reads resolve the session through its indexed database row and the account join. React request caching avoids duplicate reads within a server render; sessions are not cached globally across requests, so revocation remains effective. Session activity writes remain deferred and at most hourly. Provider signing keys are cached by the verifier. Password hashing stays at its established strength and outside mutation locks; the locked operation only checks that the proved credential is still current.

Session publication locks the affected account rather than the global account-registration lock. Unrelated users therefore do not queue behind a single sign-in lock. Global ordering remains for identity ownership and privileged account mutations where it is required. The quota optimisation reduces network round trips; it is not a claim of measured production latency or throughput.

## Verification and rollout

The final targeted matrix passed **402 tests across 19 files**. A subsequent signed-cookie Unicode return-path regression also passed; the production build and all package typechecks passed. Verification results are recorded with the follow-up PR. Relevant checks include database-backed races, real signed-token fixtures, public and privileged route/action access, existing password/Google compatibility, focused UI checks, package typechecks and the production build. No new database migration is required for these corrections.

Real LinkedIn authorisation still requires the developer application, approved OpenID Connect product, exact callback registration and server-side credentials described in [LinkedIn sign-in setup](LINKEDIN-SIGN-IN.md). Test that round trip on the hosted release before enabling it for customers.

The review follows the [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) and [session-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), especially fresh proof for credential changes and effective session invalidation. Automated checks establish the tested behaviours, not the absence of every possible vulnerability.
