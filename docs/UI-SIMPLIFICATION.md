# UI simplification

Tables use individual actions. Role selection checkboxes, bulk controls, grouped decisions and row expanders have been removed. Each posting retains its own decision and Archive/Restore action. Fit rationale, available role facts and the Build CV link are visible in the row; the role title opens the full vacancy.

Filters are always visible. Hidden roles use the existing Show hidden filter rather than a second table. Keyboard help is a single visible line; selection, grouping and expansion shortcuts have been removed.

Recommendation evidence, dismissal reasons, source forms/settings, application history and learning controls use visible sections. Operational diagnostics remain on the relevant company/health pages. CV description overrides, model configuration, archived drafts and appearance controls are visible. Raw CV snapshot JSON is removed from the user interface; the evidence library remains available through its dedicated page.

The CV appearance changes have been integrated with the scaling branch and verified together.

Validation: both web production builds; 63 web tests. Browser checks cover visible filters and role information, individual archive/restore and shortlist actions, and the absence of disclosure elements on the reviewed routes.
