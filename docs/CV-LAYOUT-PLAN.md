# CV formatting contract and verification

Status: the September 2026 corrections and refactor are local, not deployed.

## Required output

- Selectable-text A4 PDF with fixed readable typography and a maximum of two pages.
- Navy is the default for new and legacy unthemed drafts. Explicit palettes and layout toggles are honoured. Foregrounds use readable black/white contrast.
- Coloured masthead, inline contact details and clickable LinkedIn label, with an optional rounded profile card.
- Work experience in the established evidence order, with company industry descriptions as callout pills beneath each job heading.
- One **Education and Skills** section. **Skills** appears first; **Education** follows. Skills use pills when enabled. Qualifications use bullets; a repeated qualification heading is omitted only when the first bullet contains the same leading label.
- All industry and skill pills centre their text horizontally and vertically, including wrapped labels. Industry pills are independent of the skill-pill toggle.
- Existing bullet limits remain six per section, 650 characters per bullet and 1,800 characters for the profile. Structured skills retain their existing 20-item / 80-character limits.
- Footer numbers reflect the actual rendered page count. Short roles stay intact when possible. Split roles and skills receive continuation headings. Section headings stay with their first content.
- No automatic font shrinking, clipping, factual invention or modification of saved application PDFs.

## Implementation ownership

`packages/core/src/cv-format.ts` is the browser-safe contract for page/content limits and section order. Content validation, model instructions and editor limits use it.

`packages/core/src/cv-pdf.ts` is the server renderer used by generation, previews, saved-revision downloads, revision validation and application recording. `cv-pdf-pills.ts` measures and draws both kinds of pills with the same font, width, wrapping, padding and centring rules. The web module only re-exports the shared renderer; it cannot diverge.

The worker measures every materialised model response before marking it ready. An oversized result gets at most two shortening retries after the initial attempt, using the actual page count and previous plan. Retries retain the selected employment and education entry IDs and revalidate source references and structured skills. Failure remains actionable and never becomes an over-limit ready CV. This does not guarantee the quality of model-written wording; review remains necessary.

Diagnostic previews may exceed two pages so the user can inspect and edit the complete content. Saving a revised CV, downloading a CV and recording an application enforce the limit. Already recorded application downloads return their frozen bytes. Previews use the same renderer, hide stale results after edits, and never call the model or persist temporary edits.

Old skill prose is retained. When pills are enabled, explicit middle-dot lists can become separate pills; otherwise a prose bullet becomes a wrapping pill. Concise individual skill labels provide the most compact result.

## Verification

- Schema and renderer tests: theme defaults, custom colours/toggles, section hierarchy and order, preserved education detail, company callouts, centred wrapped labels, continuation headings, content limits and maximum pages.
- Worker database tests: successful generation, evidence checks, duplicate-delivery protection, shortening success, bounded failure and immutable snapshots.
- Full-flow database test: save library, queue generation, run the worker with a fixed model response, save a themed revision, compare preview/download PDF content streams, record an application and confirm byte-identical application output after another edit.
- Built server: authenticate and exercise the editor, unsaved preview, palette changes, stale-preview detection and downloads. Inspect desktop/mobile layout.
- Production file tracing: Helvetica modules are included for preview, download and the CV page's server actions.
- PDF inspection: user CV plus light/dark palettes, disabled toggles, long contacts, wrapped labels and multi-page diagnostics. Check text/page bounds, links, hierarchy and actual footers.

Local tests use an isolated disposable PostgreSQL database and a fixed model response. They do not establish that the currently deployed web/worker are running these changes or replace a fresh deployed model-generation check.
