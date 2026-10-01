# Learning drafts and follow-up work — 1 October 2026

This checkpoint follows `d988bee`. Astra directed diagnosis and browser verification; Sol implemented the changes and independently reviewed them. The work addresses J7 learning and J8 recovery. It does not establish genuine calibration, recommendation quality or representative usability.

## Defects observed

Learning's profile, pinned statements, answers, starting preferences and tags previously used inconsistent failure handling. Moving them into the shared recovery form exposed a deeper problem: saving a sibling card refreshed the hidden profile version while leaving an older edited textarea visible. A subsequent save could overwrite newer work from another tab without a conflict. The recorded browser reproduction wrote version 5 over version 4; the failed candidate evidence is retained.

Review also found that an uncontrolled multiple-select could keep an old visible selection while receiving a new guard, and could reset to its original selection after a successful save. Profile questions could disappear with an unsaved answer when another tab answered the question. These are correctness defects, not merely awkward copy.

Follow-up work had separate reliability gaps. A profile or tag edit could commit before its synthesis request failed. An explicit forced profile update could also be coalesced into an existing routine queued request without upgrading its force flag, allowing the worker to skip the requested update.

## Development

Learning mutations now return inline results through `SettingsForm`, retaining refused or uncertain submissions and offering a separate-tab comparison link for conflicts. Profile and pinned-statement editors keep their visible text and optimistic version together. A sibling refresh may update both while pristine, but cannot advance an edited draft's submitted version. If a successful save has newer local edits waiting behind it, only that save's exact committed version may advance the draft.

Reason tags use controlled, labelled checkboxes with their selected values and comparison guard kept together. Open-question drafts are retained when refreshed server data answers or removes their question; the saved answer is shown separately and the user can explicitly discard the local draft. The normal latest-profile route remains editable if concurrent profile/list reads disagree; the server's version check protects the write. Explicit historical views hide profile and pinned-statement editing; retained answer drafts remain available.

Profile append and requested synthesis now share one transaction. Tag comparison, update, re-scoring admission and synthesis admission also share one transaction. Queue failure rolls back the edit. Forced synthesis coalescing upgrades a routine queued task without replacing its identity, priority or start time; later routine requests cannot clear the force flag. This schedules work durably but does not claim that a provider has completed it.

## Verification and judgement

The [evidence record](implementation-evidence/learning-recovery/README.md) distinguishes the original overwrite, superseded candidates, an incomplete pointer replay and final passing checks. In the final browser replay, a second tab saved version 9; a sibling refresh in the first tab did not advance its three dirty guards. Profile, pinned and answer saves all refused inline, retained their drafts and left version 9 unchanged. A later answer saved remotely remained visible beside the first tab's draft. Pristine profile/pin refreshes, consecutive profile/pin saves and consecutive tag saves also passed. Stale tags retained their selection without overwriting newer stored tags. Offline header failure and answer validation preserved entered work. Checked phone states fit 375 pixels; labelled checkboxes replace the multiple-select gesture.

The final isolated web run passed **107 tests across six files**. Database queue tests passed **16/16**, scheduler tests **13/13**. Web, database and worker typechecks and both production builds passed. Failure-injection tests prove profile/tag rollback when synthesis enqueue fails; component tests cover changes during pending saves. The [independent Sol review](implementation-evidence/learning-recovery/INDEPENDENT-REVIEW.md) found no material defect in the final guarded paths and retained the scores below. Verification began on 1 October and completed after midnight on 2 October, London time.

There are explicit remaining local gaps: starting preferences is still uncontrolled and unversioned, so its pristine display can lag incoming defaults and concurrent saves remain last-write-wins; a dirty tag editor can leave the 20-row recent-decisions list and be unmounted. Draft retention is limited to the mounted page. Value-based tag comparison does not establish a monotonic revision history. The next local development should close seed concurrency and retain dirty tag rows across list churn before claiming comprehensive Learning recovery.

The browser session and local web server were closed and the synthetic cookie removed. No paid AI, genuine learning decision, deployment, hosted mutation or external notification occurred. The local checks do not establish physical-device, assistive-technology or representative-user task success.

## Readiness and remaining development

No score increase is justified solely by these repairs. The existing J1–J9 scores remain **83, 77, 85, 83, 85, 85, 80, 83 and 70**, with the dimension ratings in the [canonical scorecard](../2026-09-29/RESCORE-90.md). Every-job 90 remains unachieved.

The ordered qualification programme remains: final-corpus source and posting quality; current verified provider replay and output review; representative first-use, repeat-use and recovery sessions; genuine learning decisions; then authorised hosted release, alert, restoration and capacity evidence. Local synthetic fixtures and scripted browser checks do not satisfy those external gates.
