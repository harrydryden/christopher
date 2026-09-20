# Extraction accuracy review pack — 20 September 2026

This pack separates reproducible machine evidence from the human review still required by the
SPEC. It is not a human-labelled golden set and does not certify release acceptance.

## Reproducible machine evidence

The expanded frozen capture is in
[`live-snapshots/2026-09-20-extraction-accuracy-expanded-2/`](live-snapshots/2026-09-20-extraction-accuracy-expanded-2/).
It contains every permitted response body, request provenance and SHA-256 hash. The oracle parses
the captured responses independently of the production adapters. Its Workday traversal follows
20-role offsets, preserves the first non-zero total, and refuses to score a source if it reaches
1,000 roles with pages remaining.

| Source | Source type | Independently enumerated roles | Captured responses |
|---|---:|---:|---:|
| Anduril | Greenhouse | 2,376 | 1 |
| Educative | Lever | 11 | 1 |
| Ode with Anthropic | Ashby | 9 | 1 |
| SmartRecruiters | SmartRecruiters | 1 | 1 |
| Workday | Workday | 365 | 19 |
| Adobe | Workday | 639 | 32 |
| Mozilla | custom HTML | 22 | 1 |
| 37signals | custom HTML, explicit empty state | 0 | 1 |

Across 3,423 identities, the frozen comparison reports 100% micro precision, 100% micro recall and
100% exact title/location/URL field agreement. Workday and Adobe are machine-evidence candidates
for the target composition's two multi-region Workday enterprises. This is machine-derived
evidence; it is not a substitute for a person checking the source, role count or fields.

The offline replay in
[`live-snapshots/2026-09-20-extraction-accuracy-expanded-replay/`](live-snapshots/2026-09-20-extraction-accuracy-expanded-replay/)
reproduces the same 3,423 identities and aggregate results without making a network request.

## Exact human inputs still required

For each company selected for the roughly 25-company golden set, a reviewer must record:

1. Company name, homepage URL, review date and reviewer.
2. The correct complete listing source URL, reached from first-party evidence, and its ATS type.
3. Whether equivalent locale URLs expose the same posting identities.
4. A manual total of open postings at a stated snapshot time. If pagination or regional selectors
   exist, the reviewer must state which pages and regions were counted.
5. For every posting in a manageable board, or a predeclared representative sample for a large
   board: source identity, exact title, location and canonical posting URL.
6. A decision for every production-only identity and every human-only identity: valid posting,
   duplicate, closed during review, non-job link, or extraction miss. Any unresolved identity
   blocks certification of that source; it must not be silently removed from the denominator.
7. For an empty board, the exact first-party empty-state evidence and confirmation that there are
   no posting-detail links.

The completed review must cover at least eight distinct ATS types, five custom HTML pages, two
JavaScript-heavy pages, two multi-region Workday enterprises, one first-party
careers page that hops to an external board, and one bot-protected site. The current machine pack
has candidates covering five ATS types, two custom HTML pages (only one populated) and two Workday
enterprises. Subject to human confirmation of those candidates, composition still needs at least
three additional ATS types and three additional custom HTML pages, plus two JavaScript-heavy pages,
one external-board hop and one bot-protected site. Empty pages count towards the five-page custom
HTML composition when their empty state is confirmed, but they provide no positive-role recall
evidence. Adding four populated custom HTML cases is therefore recommended for stronger recall
evidence; it is not an additional SPEC requirement. A single company may satisfy more than one
composition category when the reviewer records that explicitly.

The section 9 scoring thresholds are: at least 80% automatic discovery at confidence 0.85 or
higher; zero wrong sources automatically accepted; 100% resolution after at most one confirmation
or one pasted URL; at least 98% recall and 98% precision for Tier-1 extraction; and at least 90%
recall and 98% precision for Tier-3 extraction. The separate AI evaluation set calls for 40
homepages with correct careers URLs and 15 recorded HTML listings with hand-counted postings.

## Assisted recovery evidence

The database-backed regression in `apps/worker/src/e2e.test.ts` proves the bounded assisted path:
automatic discovery records `not_found` without a source; a person supplies a known Greenhouse
board URL; discovery verifies and activates that exact source; the queued scan reads five postings;
and four matching roles enter the account's table. The web action integration test separately
proves that the pasted URL is queued unchanged with URL-specific deduplication. This is automated
workflow evidence, not a human confirmation of any live company source.

## Reproduction

Capture permitted public responses and compare them:

```bash
pnpm exec tsx scripts/extraction-accuracy-capture.ts \
  --output docs/live-snapshots/2026-09-20-extraction-accuracy-expanded-2
```

Replay the frozen bodies without network access:

```bash
pnpm exec tsx scripts/extraction-accuracy-capture.ts \
  --replay docs/live-snapshots/2026-09-20-extraction-accuracy-expanded-2 \
  --output docs/live-snapshots/2026-09-20-extraction-accuracy-expanded-replay
```
