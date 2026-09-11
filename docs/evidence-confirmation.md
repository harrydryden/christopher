# Responsibility confirmation

Each responsibility or outcome appears in a table with **#**, **Confirmed** and **Narrative** columns. The job block shows how many rows are confirmed. Confirm the facts you can substantiate, set the block to **Active**, then select **Save library**.

- New and existing experience rows start unconfirmed unless their exact wording has an explicit saved confirmation. An Active block alone does not confirm its rows.
- New CVs and role qualification use only confirmed rows from Active experience blocks. Draft and Inactive blocks remain excluded even when their rows are confirmed.
- Editing or removing a row clears its confirmation. Other rows retain their confirmations; adding a row does not inherit another row's confirmation.
- Education, skills and interests continue to use the block's Draft/Active/Inactive status.
- Confirmations are saved in versioned library JSON and retained by export/import. Historical CVs and submitted application snapshots remain unchanged.

Confirmation records the row's canonical wording rather than its position. Generation intersects saved confirmations with current responsibilities before grouping jobs, so removed or unconfirmed text is never passed as experience evidence. New generation tasks snapshot only the eligible evidence; the worker also applies the eligibility rule. An entirely ineligible library produces an actionable message before an AI call is queued.

## Company context

Employment history has an **Industry descriptions** column immediately after Company. Enter up to 10 short, comma-separated descriptions; editing a company's descriptions updates all its jobs. The former entry-count column is removed. Keep company context here rather than mixing it into responsibilities.

The CV model selects up to two stored descriptions that best suit the target role. The server validates each selection against that job's stored descriptions and rejects invented industries. Selected descriptions appear below the job heading in the draft and PDF, separately from achievement bullets. They are retained in saved CV revisions and application snapshots. Older libraries and CVs without this optional field remain readable.
