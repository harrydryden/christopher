# Reliable CV styling

Status: structured skill items and visual themes implemented locally on `codex/cv-layout-rules`. This branch is independent of the company scaling work. Not merged or deployed.

## Implemented

- Optional individual skill labels in library blocks, selected verbatim by the model and checked against their source. Existing prose is retained without automatic splitting. Active/draft/inactive eligibility still applies.
- Version 1 themes: Navy (default), Gold, Forest and Plum presets; custom accent, page, introduction and pill colours; panel and pill toggles. Automatic black/white foregrounds provide readable contrast.
- Themes saved with the library and materialised into new CV content. Draft palette/skill edits save a new revision. Legacy CVs without themes retain the plain renderer; saved application PDFs remain frozen.
- PDF coloured masthead containing name, inline contact/LinkedIn and a rounded profile card; thick coloured underlines spanning the body text width between the page margins; wrapping skill pills; continued job headings. No outer page border. Structured skills render as individual bullets when pills are disabled.
- Appearance controls in the library and draft editor, an illustrative palette sample, an exact saved-PDF preview link and an on-demand PDF preview of unsaved edits. The preview uses the download renderer, reports actual page count, does not write to the database or call AI, and hides stale output when edits change.

## Validation and rollout

171 core tests, 24 AI tests, 6 worker CV tests and 30 targeted web tests passed, plus workspace type checking and the production build. Database regressions cover skill/theme persistence and immutable application PDFs. Browser verification covered library save/reload, palette changes, revised skills, inline PDF responses and mobile width. Light/dark and long PDF fixtures were rendered; extracted skills and link annotations were checked. The final example PDF uses synthetic content.

No SQL migration is needed: optional validated fields are stored in existing JSON content and snapshots. Deploy web and worker together before creating structured-skill CVs. A fresh production model generation still needs verification; local generation validation used fixtures, not a paid model call.

The following sequence records the broader layout roadmap; measured two-page fitting and automatic content shortening are not implemented.

## Builder refactor

Theme schemas, defaults and foreground selection are centralised in `packages/core/src/cv-theme.ts`. Navy is the first preset and default for newly saved libraries and generated content. Dark headers use white name/contact/link text; light profile cards and pills use black text. Presets change colours without resetting layout toggles. Advanced colour and layout controls sit behind a disclosure; the selected/custom palette is explicit.

The draft editor separates appearance, content and PDF preview. Display ordering is shared with the renderer. Existing evidence labels remain available in the editor while skill output uses “Skill”. Legacy prose is never split automatically; the editor explains how to opt into individual skill labels via the library. A legacy plain CV keeps its layout until the user changes appearance.

Palette values are excluded from model requests; evidence and writing preferences remain. All persisted themes and skill arrays are server-validated. Preview requests require a session and reject bodies over 150 KB. Preview URLs are revoked when replaced/unmounted; in-flight work is aborted on unmount. Theme-only edits do not create remembered wording changes. Saving a default belongs in the evidence library; a draft's appearance applies to that revision.

## Contract

Keep PDFKit and structured CV content. The application owns typography, spacing, page geometry, headings and links; the model owns supported wording and selection. Style preferences may guide prose but cannot override the template. PDFKit supports measured text and inline links: https://pdfkit.org/docs/text.html.

The contact paragraph includes a clickable LinkedIn label after a separator. Ordinary details fit on one line at 9pt; unusually long details wrap without clipping or shrinking. Empty contact details produce only the link, without a leading separator.

## Implementation sequence

1. Extract a versioned template with explicit A4 dimensions, margins, font sizes, line spacing, paragraph gaps and footer reserve. Start from the current navy/grey style. Render synthetic short, typical and long fixtures for visual review before adopting broader visual changes.
2. Build a measured layout pass shared with drawing. Record each block's page and bounds using exactly the same font and wrapping options. Keep section headings with a job heading and its first bullet. Move short jobs intact when they fit on a fresh page; split long jobs only between bullets and repeat the job heading with “continued”. Handle an individually oversized block explicitly rather than clipping it.
3. Render qualifications as separate bullets under Education and Skills without repeating the same qualification as both heading and bullet. Preserve distinct supporting detail and source identity; do not remove text through fuzzy matching.
4. Introduce a render report: page count, overflow, stranded headings and template version. Target two pages at fixed readable typography. If the result exceeds two pages, offer a bounded content-shortening pass using the measured excess and existing evidence. Validate and measure the candidate again. Preserve the original revision, show wording changes for review, and retain a clearly labelled longer draft if it still does not fit. Never silently drop qualifications, invent evidence, clip text or shrink the whole document to force a fit.
5. Show the actual rendered PDF in the draft review, with page count and any fit warning. Preview and download must use the same saved revision and renderer. Store the template version with revisions; retain immutable submitted application PDF bytes. Old content without a template version needs an explicit legacy fallback. Unsaved edits must be saved before preview/download, or clearly displayed as a separate temporary preview.
6. Ship only after fixture checks and a fresh CV generation through the deployed web and worker. Compare its preview and download and check a previous application PDF remains byte-identical.

## Acceptance checks

- Contact text and LinkedIn share a baseline for the normal fixture; the link annotation points to the correct profile and does not cover the profile section. Cover absent URL, absent contact and long contact text.
- All text stays inside the content bounds; page numbers stay in the footer. No blank trailing page or stranded section heading.
- Short jobs remain together when practical; long jobs have labelled continuations and intact bullets.
- Every qualification is retained once, with its distinct supporting detail.
- Two-page success is based on the rendered output. Excess content yields a visible review state, not an unverified success claim.
- Automated checks inspect extracted text, page geometry and annotations. Render all fixture pages for visual regression review with pinned fonts and renderer versions.

## Limits

Layout checks cannot prove factual accuracy or select the best achievements. Shortening remains a content edit requiring review. A single font/spacing template cannot guarantee two pages for arbitrary input without changing content. Infrastructure changes are unnecessary for the contact correction; the later preview/report workflow will require core, worker and web changes together.
