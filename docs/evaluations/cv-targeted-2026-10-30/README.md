# Targeted CV qualification — 30 October 2026

These artefacts use an invented candidate and role, never a customer record. The PDF is the exact content returned by the final qualified replay, rendered with its saved theme. It is **one page within a two-page maximum**, with 12 pt body text and 11 pt skill text. A page maximum does not force the CV to fill all available pages.

The confirmed brief features the Head of Operations role, summarises the Operations Manager role in one sourced bullet and omits the Calder role. The PDF follows these choices. All nine printed claims passed the provider support check; a missing requirement remains partial rather than being invented. The separately verified skill probe proposed ten skills in four categories. It does not automatically insert them into the CV or Library.

The Executive Summary occupies four rendered lines, exceeding the two-to-three-line editorial guide. This is an actionable editorial observation, not a factual failure or a reason to truncate the user's wording. The page maximum is a separate hard build constraint. The fixture retains a legacy Education block containing two qualifications; no automatic education/training reclassification is implied.

## Scope and cost

The final qualification uses prompt set `951386df60b9`. Rubric and initial evidence plan are cached synthetic fixture inputs. Authoring and review use genuine provider responses. The continuation reuses both previously paid author responses only after their prompt, model, provenance and exact request hashes match, then performs two fresh review calls against the final eligible-evidence policy. Two fresh suggestion/verification calls qualify skills separately.

The shared $10 transport ledger settled at **$1.354135** across the initial and final runs. The final continuation added $0.471457. Reported replay costs include reused responses; replay wall time is offline execution time and is not live provider latency. No production database, account budget or customer Library was changed.

The current reports are `../cv-replay/report.json` and `../cv-skill-live-probe.json`. The first 30 October replay is retained as historical evidence, because its claim audit preceded the final separation of eligible printed evidence from full-library requirement scoring. Raw provider recordings stay local; their digests are recorded below, without publishing provider signatures.

- SHA-256 `cv-live-provider-recording.jsonl`: `8f85df2b3ebcbdc593a8ed3c7ae97fb69e8998c6cf839c4784a42fdcb8b1e4c1`

- SHA-256 `qualified-cv.pdf`: `00cee7858b4fb1553f1711f88bea006708f68db1819ba3c2e91bdbf1dc20eb62`

- SHA-256 `qualified-cv.json`: `24f7de95d93d751cea4434e6b6eb9196947e26182998229a2f99961b8bf53f65`

After the final regression fix preserving more than six selected qualifications, `final-fit-replay.json` confirms the same recorded build still passes all four invariants with zero recording misses. This replay makes no provider calls and does not add to the paid ledger.
