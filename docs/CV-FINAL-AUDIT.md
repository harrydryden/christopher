# CV builder final local audit

Completed 11 September 2026. The source changes have not been deployed.

## Result

The local builder applies the agreed two-page limit, navy default and explicit custom palettes; the combined Education and Skills section places Skills above Education. Both industry and skill callouts use centred pills. Existing bullet limits are unchanged. Preview and download share one renderer; recorded application PDFs remain frozen.

The supplied CV was re-rendered after the refactor and visually inspected on both pages. It remains two pages with correct footer counts, retained role/qualification content, industry callouts, skill pills and a working LinkedIn target.

## Refactor and additional fixes

- Shared browser-safe limits/order in `cv-format.ts`, used by schemas, model instructions, editor and renderer.
- Shared server PDF renderer, validated at its entry point. Removed the unreachable plain-layout branches.
- One measured pill layout/drawing implementation for skills and industries, including wrapping, centring and font resets after continuation headings.
- Section/group headings reserve the space for their first content. Short jobs move intact when practical. Oversized header content produces an explicit error instead of painting beyond the page.
- Corrected the appearance sample to show company callouts and the same subsection order as the PDF.
- Added missing standard-font tracing to the PDF preview route; verified font modules in the production build traces for preview, download and CV server actions.
- Added a complete database-backed library → queued task → worker → revision → preview/download → frozen application regression test.

## Evidence

| Check | Outcome |
| --- | --- |
| Core tests | 172 passed |
| AI tests | 24 passed |
| Worker CV database tests | 8 passed |
| Web action/database tests, including complete flow | 32 passed |
| Renderer, preview route and library editor tests | 15 passed |
| Workspace TypeScript checks | Passed |
| Production Next.js build | Passed |
| Preview/download comparison | Identical PDF content streams; timestamp metadata excluded |
| Application immutability | Byte-identical download after later CV edits |
| Built-server browser check | Login, saved CV, palette change, stale preview, refreshed PDF, save as new revision, saved palette retained |
| Mobile browser check | 390px viewport, 390px document width, no displayed errors |
| PDF visual/geometry checks | User CV plus Gold, dark, disabled toggles, long contact, wrapped text and multi-page diagnostic fixtures |
| PDF text/link bounds and footers | Passed across all inspected pages |

Tests ran against an isolated disposable PostgreSQL database. The complete-flow test replaces only the model response with a fixed fixture; real materialisation, worker state changes, rendering, HTTP route handlers and database persistence execute. Browser checks ran the production build against that test database.

## Practical limits

A local test does not confirm the version currently deployed to web and worker. No paid/live model generation or deployment was performed. A final release check should deploy both services and generate one fresh CV; wording quality and factual selection still require review. An over-limit diagnostic preview is intentional, while saving/downloading a revised CV and recording a new application enforce the two-page maximum.


## Content budgeting follow-up

The original page-count retry was insufficient: it asked the writer to shorten without assigning space to individual blocks. Fresh generation and editor refitting now share character allocations, relevance/recency weighting, protected qualifications/employment and repeated PDF measurement. The editor can refit current unsaved wording into a new revision. No text clipping or font reduction is used.

Regression coverage includes an oversized CV reduced to two pages while retaining six roles and its qualification, specific retry budgets, bounded failure, missing-entry rejection, and refitting unsaved edits without overwriting the source. Local checks use a stubbed model with the real renderer and database; live model quality and deployed behaviour are not asserted.


The subsequent [full builder review](CV-BUILDER-REVIEW.md) adds requirement scoring, factual assessment, immutable source provenance and finalisation gates. Its verification boundaries supersede the earlier download workflow described above.
