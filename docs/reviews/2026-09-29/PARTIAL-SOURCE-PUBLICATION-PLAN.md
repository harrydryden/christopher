# Publishing useful roles before a long listing finishes

Status: development design, **not implemented or acceptance evidence**. This is the next substantive J2 development after scoring recovery. It follows the observed Siemens continuation that staged roles across claims without publishing any to the catalogue. The current partial-at-expiry path is not equivalent to useful results during the scan.

## Required user outcome

A followed company with a long listing should make verified matching roles available as pages arrive. The interface should continue to say that the listing is incomplete. It must never imply that all roles were checked, close an unseen role, or complete first-scan setup merely because a chunk was published.

## Implementation order

1. **Add durable publication progress.** Extend the HTML generation with a published-page cursor, a first-scan seeding decision and cumulative newly created role count. Store each page's observation time. Choose the seeding decision once under the source lock before the first publication; preserve it across claims and boundary restarts. Existing checkpoints need a conservative observation-time backfill, not the migration's current time.
2. **Separate positive publication from scan completion.** Refactor the existing scan commit into shared positive reconciliation plus an explicit terminal branch. A continuing chunk may create/update/reopen roles, apply current account gates and request descriptions/scoring. It must not insert the terminal `scans(task_id, source_id)` marker, clear the checkpoint, record a complete source, count absence, reset source failure/backoff state, trigger rediscovery or finish the scan run. Keep parser-recipe/source-hash writes terminal too: the recipe participates in the generation fingerprint, so changing it during publication would invalidate the next claim unless that transition is explicitly fenced and recorded.
3. **Commit roles and progress together.** Fence task ownership, source fingerprint and the generation revision; lock the source and generation in the existing order. Read the unpublished page interval from durable storage, rather than trusting an old in-memory cursor. Publish that interval and advance its cursor in the same transaction. A crash after staging must be recoverable; a crash after publication must not duplicate events, requests or new-role counts. Bound every chunk; do not reprocess the whole prefix on every claim.
4. **Preserve evidence freshness.** A page observed earlier must not overwrite newer role details or reopen a role whose later observation established a different state. The per-claim resource lease does not exclude another task between claims: the current tests explicitly permit an unrelated manual scan during continuation. Use page observation times with the existing `jobs.lastSeenAt` and `careerSources.lastOkScanAt` as conservative fences under the source lock. Skip every positive path, including insertion and user-origin adoption, where its page time is no later than the applicable stored fence. These existing commit timestamps may discard valid delayed observations, but avoid adding unnecessary job/source columns and cannot make an older page fresher. A later complete scan must not be undone by publishing an older page. If `lastOkScanAt >= generation.startedAt`, suppress the old generation's entire terminal absence pass and preserve the newer source success metadata, counts and hash; later pages may still supply positives observed after the fence. A terminal old generation must not count new misses over a newer completed scan. Do not stamp delayed or expired observations as freshly seen at publication time.
5. **Finalise once.** Complete traversal still uses the complete current generation for coverage and absence reconciliation. The final scan count includes earlier committed creations, and its traffic totals retain the interrupted-metrics rules. Skip positive work already published unless required to apply a genuinely newer observation. Only terminal commit writes the existing once-only scan marker and clears its checkpoint.
6. **Keep drift and expiry bounded.** A changed boundary discards unpublished pages and resets the current-generation cursor without combining old and new pages as complete coverage. Previously published positive observations remain historical observations; they are not deleted because the listing moved. Preserve the original expiry and restart cap. Expiry or repeated drift ends partial, with no absence/closure inference.
7. **Explain progress in the interface.** Show that some verified roles are available while the company is still being checked. Keep incomplete/error attention visible and first-scan completion truthful. A publishing counter must distinguish distinct observed roles, matching account roles and new catalogue rows; those are different quantities.

## Verification gates before release

| Situation | Required evidence |
|---|---|
| First 20 pages of a longer listing | Matching roles visible before the second claim; no terminal scan, no first-scan completion and no missing/closed roles |
| Worker stops after staging, before publication | A fresh process publishes the uncommitted interval exactly once |
| Publication transaction fails | Neither catalogue changes nor cursor/count changes survive |
| Worker stops after publication | Retry adds no duplicate discovery events, scoring requests or new-role count |
| Gate changes between read and publication | Current locked account preferences govern admission |
| First scan spans several claims | All pre-existing day-one roles retain seeded semantics; later genuinely new scans remain distinguishable |
| Boundary drift, source edit or lost lease | No stale/unfenced write; no combined-generation completeness; original limits preserved |
| Newer manual or scheduled observation between claims | Older pages cannot regress details, freshness, closure or the newer scan's absence count |
| Expiry, repeated drift or pacing interruption | Useful safe observations retained; incomplete state visible; zero false closures |
| Final complete generation | One scan marker; correct total counts; existing two-miss and six-hour separation rules still hold |
| Phone and keyboard use | Roles are usable during the scan; progress and next action understood; no new horizontal-scroll dependency |
| Production pacing | Bounded transaction duration/memory; measured useful-result latency without paid AI or artificial host acceleration being counted as production capacity |

Retain deterministic adversarial fixtures and a separately scoped live observation. This development alone cannot qualify J2 at 90: independently labelled posting recall/precision, representative usability and the agreed operating envelope still need evidence.
