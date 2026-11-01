# ADR 0004 — Use measured CV space for relevant evidence

Status: Accepted, 1 November 2026. Implemented and verified locally; hosted CI pending. Not deployed.

## Decision

A page limit is available space for distinct, relevant evidence, not a request for filler. Generation and explicit Rewrite should use that space intelligently when confirmed evidence supports it. Sparse evidence may produce a shorter CV. Save and Check continue to preserve the person's exact wording under ADR 0003.

The initial writing envelope takes the selected font face and body size into account through measured glyph width and line height. It also reserves space for the selected document's structural elements using its actual section counts. This is an estimate before wording exists: the final rendered PDF remains authoritative, and the font is never silently reduced to fit.

Experience allocations may allow up to the existing six-bullet schema limit where there are enough distinct confirmed rows and sufficient block space. The writer is instructed to favour additional supported priority achievements over unused space, without repeating claims, padding sparse evidence or expanding the concise summary. User ranking, essential coverage, explicit omissions and Summarise choices remain authoritative.

The fitter measures the eligible candidate before applying advisory per-block bullet caps. Content that already fits is not removed solely because a conservative writing estimate allocated fewer bullets. Mandatory source eligibility, structural limits, exact selected skills and one-bullet Summarise rules still apply before that measurement. Overflow uses the existing evidence-weighted removal and measured fitting process; no additional model call is introduced solely to fill spare space.

An employment heading starts with one sourced industry label alongside company, role and dates. Its pill aligns to the heading's measured capital-glyph box, with the heading's font size unchanged. Long industry text may be visibly abbreviated with an ellipsis to keep the pill on one line; the recorded source value is unchanged. Other pills and finalised PDF bytes remain unchanged.

## Acceptance and verification

- Compare one-, two- and three-page envelopes across the supported faces and body sizes; test structural overhead separately from font scaling.
- Rich, source-supported candidates retain useful evidence that fits, with weighted pruning when needed. Sparse evidence is never padded.
- Preserve essential evidence, user rank, explicit omission, Summarise, stable source references and matching user skill order.
- Save and Check never author or fill a document implicitly.
- Visually inspect industry cap alignment, descenders, long labels and long employment headings in legacy and targeted templates.
- Qualify the changed author instruction through the existing bounded synthetic live evaluation and retain failed evidence if any. Do not copy an old report as verification of a new prompt set.

### Local verification

At the runtime/prompt freeze (`839f32787cdd`), the focused fitting suite passed 40 tests and the PDF suite passed 36 tests. Core and worker typechecks passed. Coverage includes an author that obeys the supplied budget, sparse evidence, one-/two-/three-page and font comparisons, a near-boundary fit requiring one removal, and correction of a multi-bullet Summarise answer. The source retains the hard one-bullet Summarise guard before baseline fitting and rejects a violating optional improvement.

The complete core suite passed 797 tests across 55 files, the complete AI suite passed 207 tests across 12 files, and the worker CV suite passed all 30 tests. Three adjacent tailoring assertions were updated to the measured contract: a fitting candidate retains its evidence; under real page pressure one duplicate carrier is removed while both distinct essential requirements remain represented. Core, worker and AI typechecks passed.

An independent synthetic writer obeyed the supplied budgets using the same six-role source, including education. The former budget was 4,195 characters and produced 20 bullets at every tested font/size. The new measured envelopes retained more supported candidate content while all four outputs still rendered to two A4 pages:

| Font and body size | Allocated characters | Printed bullets, including education |
| --- | ---: | ---: |
| Course of Life, 11 pt | 7,207 | 33 |
| Course of Life, 12 pt | 5,998 | 30 |
| Arial, 11 pt | 7,237 | 33 |
| Arial, 12 pt | 6,024 | 31 |

Independent page inspection found fuller second pages, aligned industry pills and no clipping or overlaps. These are deterministic local layout diagnostics, not a claim about live model quality, hiring outcomes or a universal fill percentage. Sparse confirmed evidence may correctly leave space unused.

The final production build and complete browser smoke passed. Live qualification at prompt set `839f32787cdd` passed with all ten printed claims supported and 90% priority coverage; its sparse targeted fixture appropriately used one page. The skills probe returned ten suggestions across three categories. Three CV calls and two skills calls cost $0.750221, bringing the existing cumulative evaluation ledger to $4.844924 of its $10 cap. This sparse live case checks factual quality and release compatibility; the richer deterministic fixtures above check utilisation. It is not evidence that every live draft fills two pages.

No migration is required; existing finalised downloads continue to use their immutable stored PDFs. Hosted CI for this change is pending; no deployment has been performed.
