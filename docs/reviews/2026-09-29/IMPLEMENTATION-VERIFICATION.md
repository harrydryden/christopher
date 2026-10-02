# Implementation verification — 29 September 2026

This records the local development checkpoint on `codex/jtbd-90`, based on main `ebb346b`. The original forensic baseline remains in `VERIFICATION.md`. All PostgreSQL writes and browser mutations below used disposable local accounts, synthetic Library evidence and seeded vacancies. No production change, external notification or paid provider request was made.

## Automated checks

| Check | Result | Evidence |
|---|---|---|
| Full web suite | 1,228 passed, 137 files | `implementation-evidence/web-final.log` |
| Full core suite after HTML precision repair | 664 passed, 40 files | `implementation-evidence/core-final.log` |
| AI package | 184 passed | `implementation-evidence/test-results.json`; local AI log section |
| Database package | 98 passed | `implementation-evidence/test-results.json`; local DB log section |
| Full worker suite | 635 passed, 13 skipped | `implementation-evidence/test-results.json`; local worker log section |
| Release/configuration suite | 117 passed, 2 skipped | `implementation-evidence/release-tests.log` |
| All five package type checks and evaluation-script type check | Passed | `typecheck-final.log`, `eval-typecheck.log` |
| Production build | Passed | `build-final.log` |
| Production-mode browser smoke | Passed: authenticated pages, CV evidence/edit/review/finalisation and tailoring fixture flows | `smoke-final.log` |
| Ordinary evaluation report gate | Pass with explicit unverified warning | `evaluation-gate.log` |
| Strict release evaluation gate | **Expected refusal**: no verified published passing CV replay at current prompt set `e06dce7dc560` | `strict-evaluation-gate.log` |

These are separate runs, not one uninterrupted final-commit CI execution. Focused tests on late fixes supplement them; overlapping tests must not be added to the full-suite counts. The first broad run exposed three web failures; the subsequent web run exposed two more. Stale test expectations, client/server import boundaries, an action-authorisation inventory omission and an ordering-dependent assertion were corrected. The original broad failing logs are retained locally rather than presented as a green run. The final smoke also caught its obsolete generic Save selector after the Library footer became “Save writing preferences”; the test now uses that explicit accessible label and was rerun. Worker skips and release skips remain skips, not passes.

Commands, from the repository root, using Node 22 and pnpm 10.33:

```sh
# DATABASE_URL and TEST_DATABASE_URL point only to disposable local PostgreSQL databases.
pnpm -r test
pnpm --filter @ava/web test
pnpm --filter @ava/core test
pnpm typecheck
pnpm typecheck:eval
pnpm test:release
pnpm build
pnpm smoke:web --no-build
pnpm exec tsx scripts/check-evaluation-reports.ts
AVA_EVAL_GATE_REQUIRE_VERIFIED=1 pnpm exec tsx scripts/check-evaluation-reports.ts
```

Focused checks exercise atomic suggestion acceptance, stale-homepage discovery fencing, unresolved Health scan states, truthful submission dates, global due-work pagination, exact-text quote invalidation, current-employment evidence, stalled import retries, lossless Library merge and conditional single/bulk Undo. A stale item rejects the entire bulk Undo without partially undoing other rows. The central authentication inventory also covers the new exported actions. Subsequent focused checks passed 105 action/integration tests, 20 RolesTable tests, and 10 worker HTML scanning cases; these overlap broader suites. All four exported decision-writing actions now refuse a runtime null decision; only the conditional Undo actions can clear decisions. A regression compares decisions, events and queued tasks before/after rejected direct calls. Lint scripts only print “no lint configured”, so no lint qualification is claimed.

## Browser observations

Production-mode local Next.js app, Chromium automation via agent-browser (Node 25 for that CLI only). Screen sizes represent browser viewports, not physical-phone or assistive-technology certification.

- Roles at 320px: document width 320px; cards span x=30–290 with no clipped right edge. The first role title control is 44px high and begins at y=593px: header/status/filter space still has a material phone-density cost to evaluate with users. Filters and Menu start collapsed; Escape closes Menu and returns focus to its trigger. [Final Roles screenshot](implementation-evidence/roles-final-320.png).
- Applications at 320px: no document overflow. A synthetic Interview item retained an unknown submitted date. Saving a next action dated 28 September made it appear in the Overdue working view on 29 September. The automation tool's date `fill` initially left the value blank; a native DOM value/input/change roundtrip then exercised the real form save. This is persistence/filter evidence, **not** date-picker usability evidence. [Applications screenshot](implementation-evidence/applications-320.png).
- Filled Library at 320px: one editable input per employment/evidence field. Two actual browser tabs saved competing versions: the stale save was refused; reload retained the original local wording and showed saved wording separately; explicit choices permitted a new version. Database inspection confirmed version advancement and retained evidence. The original unsaved-version download was invoked, but downloaded bytes were not separately inspected. The final conflict save was verified at Library version 5, with the chosen local Bio present in stored JSON. [Earlier conflict screenshot](implementation-evidence/library-conflict-320.png).
- That browser exercise revealed a false conflict caused by JSON object key ordering. Canonical structural equality and two regression cases now distinguish key order from genuine content changes. Original recovery JSON is preserved unchanged. A fresh two-tab Bio conflict on the rebuilt app produced exactly one genuine conflict, retained both versions and fit 320px without document overflow. [Final conflict screenshot](implementation-evidence/library-conflict-final-320.png).
- The production smoke exercises CV fixtures, review and tailoring flows. It does not establish live model faithfulness, real PDF review quality or independent user comprehension.

Earlier screenshots with a development badge or the pre-fix role-card margin are diagnostic history, not final UI evidence. Accessibility semantics and automated focus checks are useful but do not replace screen-reader, software-keyboard, text-zoom and unaided participant sessions. Those remain acceptance work.

## Live source observations

Command:

```sh
pnpm acceptance:live -- --browser --concurrency 1 --output docs/reviews/2026-09-29/implementation-evidence/live-sources-final.json
```

The production browser fallback was enabled, AI was disabled, and cases ran serially so queueing did not consume their discovery deadline. No account data or database was used. The manifest's source labels were checked on 20 September; they are not independent current posting snapshots.

| Observation | First run | Final run |
|---|---:|---:|
| Cases | 25 | 25 |
| Correct automatic source matches | 17 (68%) | 16 (64%) |
| Wrong automatic source accepts | 0 | 0 |
| Adapter “complete” outcomes | 23 | 24 |
| Adapter failures | 2 | 1 |
| Independently labelled posting-identity cases | 0 | 0 |
| Posting recall / precision | Unmeasured | Unmeasured |
| Acceptance verdict | Fail | **Fail** |

[First observation](implementation-evidence/live-sources.json), [targeted extractor recheck](implementation-evidence/live-sources-extractor-after.json), [final whole-set observation](implementation-evidence/live-sources-final.json).

Extraction is exercised against each manifest's expected source, including when discovery did not find it. Therefore 24 adapter completions do **not** mean 24 successful end-to-end journeys. “Complete” is an adapter outcome, not proof that all and only vacancies were found. Six sampled false positives across Automattic, Siemens and Zapier were removed by the extractor repair; the three-case recheck returned none of those six links. Without independent vacancy labels, it would be incorrect to generalise that into a precision score. The source results still fail the existing 80% automatic-discovery gate.

## Outstanding qualification

No current verified provider replay, human usability sessions, 50 genuine decision calibration, new hosted capacity proof, delivered operational alert, or full managed web-and-worker restoration was performed. Existing committed fixtures explicitly remain unverified. Strict release qualification refuses them; platform auto-deploy configuration still needs separate protection as documented in `docs/DEPLOY.md`.

[RESCORE-90](RESCORE-90.md) contains the resulting scores, dimension floors, ordered development/qualification work and dependencies. **This checkpoint does not confirm the user's 90-point objective.**
