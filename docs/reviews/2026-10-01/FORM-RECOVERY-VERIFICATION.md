# Preserve entered work through failed saves — 1 October 2026

This checkpoint follows `77d068d` and repairs a reproduced loss-of-input defect affecting first-use preferences and the shared forms used by application, account and CV workflows. Astra directed diagnosis and browser verification; Sol implemented and independently reviewed the repair.

## Observed problem and resulting behaviour

A first preference save with an empty keyword correctly returned a validation error, but React also reset the other fields: the typed location and exclusions disappeared and the remote checkbox reverted. Saving starting preferences offline was worse: a rejected server action replaced the form with the workspace error screen, losing the entered work from view.

`SettingsForm` now catches unexpected action failures and preserves inputs while showing an inline, focused message. It describes an uncertain outcome because a server may have committed before its response was lost. It offers a new-tab link to inspect saved work while keeping the edited page open, and makes no automatic retry. Expected validation errors remain specific to their fields; framework navigation signals still reach the router.

A native reset listener prevents React's automatic reset after refusal or when newer edits exist. It allows the normal reset after confirmed success without intervening edits. The first synthetic-event implementation failed; inspecting React's commit path explained why, and that failed evidence is retained. Form-owned controls elsewhere in the document are tracked too, so a CV field linked through `form=id` has the same protection. The form retains native action/submitter semantics and blocks duplicate submissions while pending. A Saved acknowledgement disappears when newer edits make it inapplicable.

## Verification and judgement

The [evidence record](implementation-evidence/form-recovery/README.md) contains before/after screenshots, database reads and exact checks. Real local Next browser checks confirmed validation retention, offline recovery followed by a keyboard save, a committed request whose response was deliberately lost, separate-tab inspection without discarding newer text, and preservation of an edit made while an earlier response was delayed. Checked phone states fit 375 pixels. A wrapped recovery link initially missed pointer clicks; a separate 44-pixel target now opens saved work by pointer as well as keyboard, preserving the original draft. Fifteen related component tests, web typecheck and the production build passed. An independent Sol review found no further concrete blocker in this bounded change.

This advances J1, J4, J6 and J8 recovery, but does not certify their complete exception matrix or representative usability. Other forms, other browsers and assistive technology remain to be qualified. Values are protected while this page remains mounted; there is no new offline queue or persistent draft store. A lost response remains ambiguous until saved work is inspected. No paid AI, production deploy, hosted mutation or external notification occurred.

J1–J9 scores remain **83, 77, 85, 83, 85, 85, 80, 83 and 70**; dimension ratings are unchanged in the [canonical scorecard](../2026-09-29/RESCORE-90.md). Every-job 90 remains unachieved. The next qualification work still requires full posting labels and source results, current verified provider replay, representative users and genuine decisions, and hosted release/continuity evidence.

A separate read-only J9 audit confirmed the deployment distinction: `.github/workflows/release.yml` qualifies an exact CI-passed commit and then checks live identities; it cannot stop provider auto-deploy beforehand. `docs/DEPLOY.md` explicitly retains that operator configuration requirement. Blocking administrator model settings would not fix that deployment path, so no unrelated runtime restriction was introduced.
