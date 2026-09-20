# Synthetic CV tailoring contrast

Generated 2026-09-20T13:02:18.360Z. This is an automated synthetic evaluation; no human review has been performed.

- Status: **automated_checks_passed**
- Model: claude-fable-5-1
- Cumulative spend for this subtask: $1.2236 of the $3.50 hard cap (including $0.6791 from the superseded first run)
- Completed roles: 3/3
- Distinct semantic plans: yes
- Blinded review: [blinded-review.csv](./blinded-review.csv)
- Separate key: [blinded-review-key.json](./blinded-review-key.json)
- Full machine report: [report.json](./report.json)

| Target role | Planned evidence emphasis | Leading evidence | Careers retained | Claims supported | Score |
|---|---|---|---:|---:|---:|
| Strategy Director | portfolio, launch | portfolio | 3/3 | yes | 100 |
| Operations Director | people, risk, launch | people | 3/3 | yes | 100 |
| Analytics Lead | analytics | analytics | 3/3 | yes | 100 |

The fixed rubrics produced three distinct, provenance-backed evidence plans from the same Library.
Each generated CV retained the full career history, while its summary and leading supported evidence
changed with the role. The factual assessor marked every generated claim supported. The strategy
plan also produced one factual follow-up question for partial launch evidence; the question is saved
in the machine report and does not appear as a CV claim.

The simple vocabulary diagnostic passed for Operations but not Strategy or Analytics because every
CV deliberately retains all three careers and therefore still contains vocabulary relevant to the
other roles. Release status rests on distinct validated source selections and leading provenance,
not keyword absence. The first run cost $0.6791 and exposed that flaw in the original grader; the
corrected run cost $0.5445. Both are included in the $1.2236 cumulative figure above.

The baseline in the blinded pack is a literal Library-derived control: the stored profile and
evidence rows placed into a CV without role-specific authoring. It is not output from the previous
production authoring engine. This evaluation therefore checks role-specific selection, factual
grounding and preservation of career history; it does not measure an old-versus-new engine quality
gain. The preference columns are intentionally blank and human review remains pending.
