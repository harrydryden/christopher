# Role workflow

The four statuses are **Shortlisted**, **Matched**, **Dismissed** and **Archived**
(`user-shortlisted`, `auto-matched`, `user-dismissed`, `archived` in the URL and the
database, which have not changed). The tab strip shows the first three, in that order;
Archived is a section below the dismissed table, with its own count, pagination and
Restore. A legacy `view=archived`, `archive=1` or `decision=skip` link lands on
Dismissed, where those roles are.

The initial view is Matched: only roles with no active user decision.
Employer availability (open/closed) remains separate. All availability states are
included by default so counts and destinations agree; users can filter availability.

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
before search filters and pagination, and tables disclose filtered totals.
Legacy decision/archive URLs remain readable. New links use the view parameter.

Migration 0013 preserves previously retained non-matches in Archive and clears
legacy hidden flags. Run normal database migrations before releasing the change.
