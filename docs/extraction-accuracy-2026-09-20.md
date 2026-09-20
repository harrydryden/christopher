# Frozen extraction accuracy observation — 20 September 2026

This is a machine-derived, independently implemented oracle, not a set of human labels and not certification of the SPEC golden set. It makes bounded public requests through the production `PoliteFetcher`, saves the complete permitted response bodies with SHA-256 hashes and provenance, enumerates source identities without calling the adapter under test, and then runs the production adapters against only those frozen responses. An uncaptured request fails, so the comparison cannot drift onto a second network response.

The six sources cover Greenhouse, Lever, Ashby, SmartRecruiters offset pagination, a populated custom HTML listing and an explicit empty HTML listing. This is useful representative evidence, but it does not satisfy the SPEC golden-set composition of at least eight ATS types and five custom HTML pages. No existing manifest label or `expectedRoleCount` was changed.

## Results

| Source | Type | Oracle postings | Identity precision | Identity recall | Exact title/location/URL field accuracy |
|---|---:|---:|---:|---:|---:|
| Anduril | Greenhouse | 2,376 | 100% | 100% | 100% |
| Educative | Lever | 11 | 100% | 100% | 100% |
| Ode with Anthropic | Ashby | 9 | 100% | 100% | 100% |
| SmartRecruiters | SmartRecruiters | 1 | 100% | 100% | 100% |
| Mozilla | HTML | 22 | 100% | 100% | 66.67% |
| 37signals | HTML explicit empty | 0 | 100% | 100% | 100% |

Across 2,419 identities, micro precision and recall were both 100%. Exact comparison of title, location and canonical URL produced 22 mismatched fields out of 7,257, for 99.70% field accuracy. URL comparison removes fragments and resolves relative URLs; it does not discard query strings or otherwise declare differing source URLs equivalent.

The Mozilla result is a concrete extraction defect. Every identity and title is correct, but the generic HTML adapter combines the visible location with the following department cell: for example, the source row's `Remote US` location is returned as `Remote US Core Services`. This report therefore does not treat identity-only success as an extraction pass.

After the HTML location extraction was corrected, the production adapters were replayed against the exact same response hashes. The report in [`live-snapshots/2026-09-20-extraction-accuracy-after-fix/`](live-snapshots/2026-09-20-extraction-accuracy-after-fix/) retains all 2,419 true-positive identities with no false positives or false negatives and has no title, location or URL mismatch: exact field accuracy is 100%. The original report remains intact as defect evidence.

The SmartRecruiters oracle follows offsets independently using `totalFound`. It refuses to publish an oracle if the independent traversal reaches its 1,000-posting safety bound while more results remain. The populated Mozilla oracle similarly refuses zero pattern matches. The 37signals zero is accepted only when the explicit no-openings statement is present and no candidate `/jobs/<detail>` link is present.

## Reproduction

Capture fresh public responses:

```bash
pnpm exec tsx scripts/extraction-accuracy-capture.ts --output docs/live-snapshots/2026-09-20-extraction-accuracy
```

Repeat adapter comparison without network access or response drift:

```bash
pnpm exec tsx scripts/extraction-accuracy-capture.ts \
  --replay docs/live-snapshots/2026-09-20-extraction-accuracy \
  --output docs/live-snapshots/2026-09-20-extraction-accuracy-replay
```

The machine-readable comparison and raw captures are in [`live-snapshots/2026-09-20-extraction-accuracy/`](live-snapshots/2026-09-20-extraction-accuracy/).
