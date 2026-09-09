# CV evidence grouped by role

Experience blocks now have a Company input with suggestions from companies already stated in the evidence library. Enter a new employer directly to make it available to subsequent blocks. This list is independent of companies tracked for vacancies.

Use CV role to link a project or achievement block to an existing role at that company. The main role block supplies the job heading and dates; linked blocks keep their own descriptive library headings. Different jobs at the same company remain separate unless explicitly linked. Existing three-part headings provide company suggestions, but no jobs are merged by guessing from company names or dates.

Before CV generation the worker combines linked evidence into one role entry, removes identical lines, and gives the model a single section reference for that role. The model is instructed to consolidate related achievements into at most six bullets. Rendering rejects unknown or repeated section references. Semantic paraphrase deduplication still depends on model quality and should be reviewed in the generated CV.

Role links are validated on save: the target must be an unlinked experience block at the same company. A role with linked blocks cannot be removed or changed to another evidence type until those blocks are unlinked. Changing its company updates its linked blocks too. JSON import/export preserves company and role links. Existing saved CVs and their library snapshots remain unchanged.

Release requires both web and worker deployment. No database migration is needed because the library is versioned JSON. After deployment, link the Spill project blocks to the main Spill role, and the SalesAPE operating-model block to the main SalesAPE role, then save the library and generate a new CV. These live-library links have not been changed by this code release.

Validation: full automated suite, TypeScript checks, production build and all 11 local smoke routes. Core regressions cover linked evidence aggregation, separate jobs at one company, invalid links, legacy libraries and rejection of a linked block emitted as another job.
