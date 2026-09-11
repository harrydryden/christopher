# Role workflow

The public statuses are Auto-matched, User-shortlisted, User-dismissed and Archived.
The initial view is Auto-matched: only roles with no active user decision.
Employer availability (open/closed) remains separate. All availability states are
included by default so counts and destinations agree; users can filter availability.

Status precedence: explicit archive, active user shortlist/dismissal, automated
match, then Archive for legacy retained non-matches. The pure core function and
shared SQL expression implement this precedence. Tables, company summaries,
status totals and CSV exports use these same rules.

New postings failing the matching gate are not inserted. Previously retained roles
that stop matching are archived with a reason and event, unless they have an active
user decision. Rescans and preference changes never override those decisions.
Archiving preserves the decision. Restoring a role with a decision restores that
status. An unreviewed role can be restored only if it currently matches; otherwise
the user can explicitly shortlist it from review. Resetting a decision returns a
matching role to Auto-matched and a non-match to Archive.

A user may shortlist or dismiss an archived role directly; this clears the archive.
Reasons are optional, with quick dismissal reasons in the review panel. Automated
archiving does not write a user decision or train preference learning.

Fit scores inform review. Legacy score hiding is retired; a minimum-fit filter is
explicit and does not change workflow status. Missing scores do not imply rejection.

The company page embeds the same RoleWorkspace as the global Roles page. Company
summaries link to exact company status views. Counts cover all retained records
before search filters and pagination, and tables disclose filtered totals.
Legacy decision/archive URLs remain readable. New links use the view parameter.

Migration 0013 preserves previously retained non-matches in Archive and clears
legacy hidden flags. Run normal database migrations before releasing the change.
