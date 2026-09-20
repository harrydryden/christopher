# CV quality evaluation

The CV evaluation now reports several dimensions instead of asking one match score to carry every
meaning. The existing match score remains unchanged for compatibility.

- **Factual support** is the proportion of assessed profile and bullet claims marked supported.
- **Priority coverage** weights essential capability requirements twice, excludes logistics and
  awards points only when every cited CV claim is supported. If an advert labels only
  responsibilities, those become the stated fallback; an empty dimension reads “Not assessed”.
- **Evidence ready to use** identifies requirements supported in the Library but not demonstrated in
  the CV. This is the bounded rewrite opportunity.
- **Logistics to confirm** reports location, working pattern and similar checks separately. It is not
  treated as evidence of capability.
- **Repetition, concision and profile focus** are deterministic editorial heuristics. They are editing
  prompts, not hiring probabilities or claims about how a recruiter will decide.

`compareCvQuality` accepts a single candidate rewrite only when its claims are all supported, its
non-logistics priority coverage strictly improves, and no essential requirement demonstrated before
the rewrite regresses. The caller limits the process to one rewrite; the comparator does not call a
model or mutate a CV.

## Contrast harness

Run `pnpm test:release` to exercise the offline contrast harness. It uses one synthetic Library
against Strategy Director, Operations Director and Analytics Lead roles. A useful result must select
the expected source evidence, lead with evidence appropriate to that role, and produce three distinct
selection plans. Vocabulary contrast is retained as secondary diagnosis and cannot make a result
pass. This catches generic output without making paid model calls.

`blindedPairwiseCsv` prepares baseline/candidate pairs with the side alternated. Its preference and
reason columns are blank by design. The export supports a later human review; passing the automated
harness must never be described as completed human review.

To create a review sheet from a JSON array of `{ id, role, baseline, candidate }` objects:

```sh
node scripts/cv-quality-contrast.mjs pairs.json > blinded-review.csv
```

For a release review, generate pairs from the same saved Library, give the CSV to reviewers without
identifying which version is the candidate, then retain the completed sheet with the release record.
Assess factual faithfulness, useful role emphasis and readability separately.

## Implemented builder flow

A new build now runs role analysis, a validated evidence plan, the optional gap quiz, writing and
PDF fitting, then an independent content audit. When the Library holds stronger priority evidence
than the first CV shows, one optional revision is written and audited against the same requirements.
It replaces the first version only after factual support and essential-coverage checks pass.

The quiz pauses work and releases its budget hold. Confirmed answers append a Library version and
start a continuation draft; skipping resumes the original snapshot. Both paths reuse role analysis,
and neither repeats the questions. The task relationship is the draft ID in the task payload,
including for status displays, interruption recovery and reservation cleanup. This avoids a
continuation being mistaken for a missing task. Manual edits clear outdated source metadata.

Before building, the interface explains these steps and quotes an estimate that includes the
optional revision. The narrative reports planning, questions and the revision decision, and the
completed log remains available during the quiz. Evidence tags sit beside evidence in a table row;
the table has its own horizontal scroll area on small screens.

The database migration is `packages/db/drizzle/0034_cv_gap_quiz.sql`. Apply it first, deploy and
verify the web application second, then release the worker. The worker is the first component that
can write `awaiting_evidence`, so the interface that resolves that state must already be live. Once
the worker has written a paused quiz, an answered parent, a continuation draft or its task and budget
records, prefer roll-forward recovery: the previous release does not understand the whole lifecycle.
An old-code rollback requires the new code to stop the worker and prove that none of those linked
states remains; archiving a parent alone is not sufficient. This work has been tested locally; it
does not constitute a production deployment.

## Live synthetic check

The [three-role evaluation](evaluations/cv-tailoring-contrast/README.md) used one small synthetic
Library for Strategy Director, Operations Director and Analytics Lead. All three produced distinct
validated evidence plans and appropriate leading evidence, retained three employment records, and
had every generated claim marked supported by the model audit. Total paid evaluation spend for this
change was $1.223595, including the first diagnostic run.

These are small, favourable cases, not a population accuracy estimate. The planner requested more
clarity on ownership of a channel launch while the final assessor accepted the existing evidence;
that disagreement remains a useful example for human calibration. The blinded comparison uses a
literal Library-derived control, not output from the previous production engine. Human preference
review is prepared but has not been performed, and no old-versus-new quality gain is claimed.

## Local verification — 20 September 2026

- Core: 371 tests passed; AI: 86; worker: 295; web: 501.
- Release-script checks: 42 passed. The 63 affected action/end-to-end tests were also re-run after
  correcting the same-page quiz continuation response.
- Workspace and evaluation-script typechecks passed; production web build passed.
- Full browser CV workflow passed: build, edit, rebuild, finalise, export, saved evidence, progress
  narration, keyboard navigation and archive/restore behaviour.
- Dedicated quiz browser flow passed: answer confirmation and destination, immutable original
  snapshot, new Library version and continuation, skip, dashboard status and streamed narrative.
- Desktop and 390-pixel mobile checks passed. The table scrolls inside its panel, tags stay in the
  evidence row, and focusing a tag brings it into view without widening the page.
- All three generated PDF examples were rendered and visually inspected.

Integration suites used disposable local PostgreSQL databases and scripted model responses. The
three-role live evaluation is recorded separately above. Human pairwise review by designated
reviewers, applying the migration to hosting, and production deployment remain outstanding; these results do not close
unrelated discovery-accuracy or operational release gates.
