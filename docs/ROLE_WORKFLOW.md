# Role workflow

The four statuses are **Matched**, **Shortlisted**, **Dismissed** and **Archived**
(`auto-matched`, `user-shortlisted`, `user-dismissed`, `archived` in the URL and the
database, which have not changed). The tab strip shows the first three, in that order;
Archived is a section below the dismissed table, with its own count, pagination and
Restore. A legacy `view=archived`, `archive=1` or `decision=skip` link lands on
Dismissed, where those roles are.

A visit that names no view opens on **Matched** — the day's new roles, those with no
active user decision — unless the account has no matched roles in that scope, and then
on **Shortlisted**, where someone with nothing new to review is already working. The
company page counts only that company's roles, so it answers the same question about the
company in hand. A link that names a tab is answered whatever the counts say
(`defaultRoleTab` in core, `resolveRoleView` in the interface's job queries).
Employer availability (open/closed) remains separate. All availability states are
included by default so counts and destinations agree; users can filter availability.

## Lifecycle

A role is at exactly one of eight stages for one account (R-7.10): **Matched** (the gate
admitted it, nothing decided), **Shortlisted** (you chose to pursue it), **Applying** (a
CV is being built or is ready), **Applied** (you recorded an application), **In process**
(screening, interview or offer — one stage, and the badge names the step), **Accepted**,
**Rejected**, and **Dismissed** (you passed on it, withdrew, or it stopped matching and
was archived).

The pieces behind a stage are stored apart — the gate result and archive marker in
`user_jobs`, the decision, the CV draft, the application row — so precedence decides when
they disagree: an application's status wins, because it is the furthest anything has got;
then a dismissal or an archive, which beats a CV; then a CV, which makes a shortlist
Applying; then the bare shortlist; then the gate. `roleStage` in `@christopher/core` and
`roleStageSql` in `@christopher/db` are the same rule in JavaScript and in SQL.

Dismissed and Archived are one stage shown in one place: the Dismissed tab, with the
archived card below it. The roles table's Shortlisted tab carries the stage as a badge
on the row — beside the title, and again beside the decision inside the panel — once a role is past
Shortlisted, with a legend under the table naming all eight; the Applications page lists
every role that is Shortlisted or beyond; the CSV export carries the stage as a column.

## Reviewing and deciding

Expanding a row loads the stored description in one round trip (`roleDetails` in
`app/actions/decisions.ts`, over the existing `fetchRoleDetails`); the page read itself stays
summary rows, so pagination never carries 50 descriptions. The panel shows that description
collapsed behind "Show more", the salary, **why this is here** — the account's matched keywords as
chips and the line that says which location term admitted it, or that it is remote, or that the
filter names no location — the fit verdict and rationale beside the score, and the decision with its
date. `user_jobs` stores the location verdict as a boolean and not the terms behind it, so the
terms are recomputed on expand with the same `evaluateLocation` the gate ran.

A decision taken from the table removes the row optimistically and leaves a five-second notice
under the table naming it ("Shortlisted VP Operations at Hims · Undo"). Undo is
`decide(jobId, null, "")`, which returns the role to the tab it left. One notice at a time.

The keyboard cursor starts on the first row, the five shortcuts are printed under the table,
`enter` saves an open reason box and `shift`+`enter` is a new line. `a` opens a one-line optional
reason box — R-6.1 encourages a reason on apply and never requires one, so `enter` on an empty box
shortlists — while `s` keeps the required dismissal reason.

"What did I decide last week?" is a **Decided** sort key and a `since=7d` window, both offered on
the Shortlisted and Dismissed tabs only, because both read the decision's date.

Deciding no longer queues the filter-suggestion call every time. `decide` and `decideRoles` count
the account's standing decisions inside the transaction and queue `suggest_filters` on every fifth;
the weekly call stays with the scheduler (R-6.9). `synthesize_profile` is still queued every time,
because its handler enforces its own five-decision threshold.

## Statuses, decisions and archiving

Status precedence: explicit archive, active user shortlist/dismissal, automated
match, then Archived for legacy retained non-matches. The pure core function and
shared SQL expression implement this precedence. Tables, company summaries,
status totals and CSV exports use these same rules.

New postings failing the matching gate are not inserted. A role a follower added
by URL is exempt from the gate entirely: it enters that account's table whatever
its keywords say, and a scan never closes it. Previously retained roles that stop
matching are archived with a reason and event, unless they have an active
user decision. Rescans and preference changes never override those decisions.
Archiving preserves the decision. Restoring a role with a decision restores that
status. An unreviewed role can be restored only if it currently matches; otherwise
the user can explicitly shortlist it from review. Resetting a decision returns a
matching role to Matched and a non-match to Archived.

A user may shortlist or dismiss an archived role directly; this clears the archive.
Reasons are optional, with quick dismissal reasons in the review panel. Automated
archiving does not write a user decision or train preference learning.

Fit scores inform review. Legacy score hiding is retired; a minimum-fit filter is
explicit and does not change workflow status. Missing scores do not imply rejection.

The company page embeds the same RoleWorkspace as the global Roles page. Company
summaries link to exact company status views. Counts cover all retained records
before search filters and pagination, and tables disclose filtered totals. The CSV export reads the
same SQL the table pages, in blocks, so the file cannot disagree with the screen; it stops at
20,000 rows and says so on its last line when that leaves anything out.
Legacy decision/archive URLs remain readable. New links use the view parameter.

Migration 0013 preserves previously retained non-matches in Archive and clears
legacy hidden flags. Run normal database migrations before releasing the change.
