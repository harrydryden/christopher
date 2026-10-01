# Health permissions and acceptance audit — 2 October 2026

This checkpoint follows `7702363`. Astra directed the audit, failure semantics, browser verification and score assessment; Sol implemented and independently reviewed the repairs. Remote main was checked again and remains `ebb346b1fa64e34c16447fffb0d47afbbfd890ac`. Development remains local on `codex/jtbd-90`.

Health now offers member source choices according to the same source identity and state rules as the server. Initial confirmation remains available. Shared-source replacement, reactivation and disabling explain the administrator boundary. Members retain account pause, re-discovery and keeping the current working source. Proposal guidance no longer implies that every follower can replace a shared source. Incomplete candidates cannot be selected by either role.

Expected stale-state refusals appear beside the choice. Unexpected errors propagate to the shared form's uncertain-outcome recovery. Successful choices refresh Health. A new source choice, discovery resolution and scan request now commit in one transaction; a failed queue insert rolls everything back. Submitting an already resolved run does no further work, including after the original scan finishes.

The full web regression found nine client-bundle failures: the shared form imported action-result helpers through the Zod validation module. Those helpers now live in a separate client-safe module, with server-compatible re-exports. An intermediate split accidentally shortened the UUID expression; the next broad run caught it. The exact original expression is restored with a regression test. Both failed runs are retained as diagnostics, not acceptance evidence.

## Verification and limits

The [evidence folder](implementation-evidence/acceptance-audit/) contains browser snapshots, inspected phone screenshots, database observations, corpus and model-gate outputs, and full regression logs. Synthetic local member and administrator accounts used separate browser sessions on an isolated database, without a worker or model provider. A member initial confirmation created one active confirmed source, resolved the run, queued one scan and removed the Health item. After a working source was inserted behind a stale member page, clicking the candidate returned an inline alert, retained the separate pasted URL and left the run unchosen with zero queued scans. The phone viewport and document both measured 375 pixels. Administrator controls were visible where member controls were withheld.

The first stale-page attempt coincided with source hot reload and is not counted as acceptance evidence. The recorded passing attempt ran after source freeze. These checks establish local Chromium behaviour, not representative user comprehension, assistive-technology support, physical-device behaviour or hosted operation. Synthetic cookies were removed and the local server/browser sessions closed; fixture databases are retained.

The final frozen-candidate full web suite passed **150/150 files and 1,358/1,358 tests**. Web typecheck and the final production web build passed. The [final suite log](implementation-evidence/acceptance-audit/full-web-tests-final.txt) and [build log](implementation-evidence/acceptance-audit/web-build.txt) record their commands and exit codes.

Focused Health verification passed 15 unit and 9 database integration tests, including queue rollback and resolved-run idempotence. Independent review found no remaining blocking issue in this change and reran 18 component/query/adapter/validation tests. These focused counts overlap the full web suite and must not be added to it. Exact Health commands are retained in [the adjacent implementation logs](implementation-evidence/learning-completion/health-permissions-tests.txt).

## Remaining development and rescore

The corpus composition gate passes for 31 cases; it measures composition, not discovery or posting quality. The strict model gate fails: neither committed report is verified for the current shipped prompt set `27311fe3cb21`. Existing posting references remain machine-enumerated and do not certify final human-reviewed recall or precision.

The forensic audit identified two further local J7 gaps against SPEC: users cannot freshly reach standing decisions older than the latest 20 to edit their reason tags, and retained preference-profile versions have no comparison view. The next development should add bounded, account-scoped history access while retaining dirty/pending editor safeguards, followed by an accessible comparison of profile versions with clear added/removed content. Verify older-decision save/conflict recovery and profile changes on keyboard and phone. The existing latest-20 draft-retention repair remains valid; it did not implement full history access.

J1–J9 remain **83, 77, 85, 83, 85, 85, 80, 83 and 70**, with unchanged dimension ratings in the [canonical scorecard](../2026-09-29/RESCORE-90.md). No job reaches the requested 90 threshold. After the remaining local Learning work, the qualification programme still requires final-corpus human posting labels, current verified provider replay and output review, representative usability sessions, genuine learning decisions and authorised hosted release/recovery evidence. No paid provider call, production deployment or external notification occurred.
