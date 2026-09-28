# The two rubrics

AVA judges a person's evidence twice, with two rubrics that must not be confused.

| | Evidence rubric (static) | Role rubric (dynamic) |
|---|---|---|
| Asks | Is this row a complete, strong piece of evidence of its kind? | Does this evidence meet what this job asks for? |
| Fixed by | The application: six types, four marks each (`packages/core/src/evidence-rubric.ts`) | The job description: up to 30 requirements extracted per role (`cv.rubric`) |
| Judged by | The person's tags and wording (rules), refined by the evidence review (A12) | The evidence plan (`cv.planning`), the writer and the audit (`cv.review`) |
| Produces | A row score, a job rating, and asks for what a row lacks | A CV, a match per requirement, a claim audit, a CV score |
| Lives | The Library | A CV draft |
| Gates | Nothing | Nothing; it selects and orders |

## The division of labour

The static rubric asks the person to write what the dynamic one refuses to invent. The writer and
the audit will not add a beneficiary, a figure, a cause or a level of ownership the evidence does
not state; the static marks (`outcome.beneficiary`, `metric.figure`, `outcome.cause`,
`responsibility.ownership`) ask the person for exactly those, before any role is in view. A Library
that scores Strong is one the writer can quote without stretching.

The one thing the static rubric passes into a build is the person's tags: the canonical evidence
carries each row's facets, and the writer treats a row tagged metric or outcome as the place a
figure or result is stated and worth leading with. The planner and the audit are told the same
thing in their own terms: tags help find candidate rows and are never evidence of a requirement.
The twenty-four marks are never sent to a build; they are judgements about wording, and the audit
makes its own.

## Where the two disagreed, and what was done

- **Marks are job-shaped, but education and skill entries were reviewed against them.** "Give the
  size: headcount, budget" is nonsense on a degree, and no page showed those scores. The evidence
  review now covers experience entries only.
- **A row the review classified but the person had not tagged scored nothing in its job's
  rating.** The rating's coverage half used the review's reading while its row half scored the
  row against no types. Now an untagged row is scored against the review's reading in the job's
  rating; on its own row it still reads "Select type", and the guidance offers the review's
  reading as the types to use, one click away.
- **Gap-quiz answers enter the Library untagged.** They are confirmed (they were asked for) and
  the review classifies them on the pass that follows; the offer above is how they get their tags.
- **Two sources of questions.** The Library's prompts (at most three a job) are about the record:
  the types no row covers. The gap quiz (at most four a build) is about this role: requirements the
  evidence does not meet. Both add rows to the same Library, and neither is shown where the other
  is. Nothing to resolve beyond keeping them labelled as they are.
- **Confirmation.** The static rubric scores every row; a CV reads only confirmed ones. The score
  describes the record and the readiness line beside it says how many rows a CV can use. Kept
  separate on purpose.

## Re-scoring only what changed

Evidence review:

- An entry is re-reviewed only when its wording changes: its hash covers the rubric version, its
  rows and its job's title and company, and no longer its tags. Re-tagging a row re-scores it in
  the browser from the review's marks, and costs no model call.
- Within a changed entry, rows whose text the entry's last review already classified keep that
  classification; the model is asked only about the rows it has not seen, with the whole entry in
  view for its questions. A one-row edit to a twenty-row job pays for one row.
- Entries that need nothing are carried forward into the new version so pruning cannot lose them.

CV evaluation:

- The role rubric is reused whenever the job description is unchanged.
- The evidence plan is keyed by the rubric and the canonical evidence, not the whole Library, so a
  theme, contact or preference change does not re-plan.
- The audit's claim verdicts are memoised by claim and source, so the re-audit of a revision
  sends only the claims the revision changed; every requirement is re-assessed because a
  requirement's verdict depends on the whole CV.
- The evidence plan is the audit's library-side verdict. Whether the library meets a requirement
  depends only on the rubric and the evidence, never on the CV, and the plan and the audit judge it
  by the same words (`EVIDENCE_JUDGEMENT_RULES`), so it is judged once per rubric and evidence: each
  audit batch is handed the plan's verdicts as settled context, answers only for the printed CV and
  the claims, and the plan's verdict is what the assessment stores. The same verdict serves the
  baseline audit, the improvement's re-audit, direct edits and child drafts (which reuse the
  parent's saved plan when the Library version and rubric are the parent's). Builds with no plan —
  untailored ones — keep the audit's own library-side judgement.
