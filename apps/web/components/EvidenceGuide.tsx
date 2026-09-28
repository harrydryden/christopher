import { EVIDENCE_FACETS_BY_NEED, EVIDENCE_FACET_LABELS, type EvidenceFacet } from "@ava/core/cv-helpers";
import { EVIDENCE_MARKS_BY_FACET, EVIDENCE_MARK_SPECS } from "@ava/core/evidence-rubric";
import { TBody, TD, TH, THead, TR, Table } from "@/components/table";

/**
 * What a type counts for in a job's rating. The weights themselves are core's (the entry scorer
 * counts the two types worth the most double); that module reaches `node:crypto` and cannot load
 * in a browser, so the word is read from the same ordering the scorer's weights follow.
 */
export function facetWorth(facet: EvidenceFacet): "double" | "single" {
  return EVIDENCE_FACETS_BY_NEED.indexOf(facet) < 2 ? "double" : "single";
}

/** "the problem named · what made it hard · …": a type's four marks, in its checklist's order. */
export function strongRowLine(facet: EvidenceFacet): string {
  return EVIDENCE_MARKS_BY_FACET[facet].map(mark => EVIDENCE_MARK_SPECS[mark].label).join(" · ");
}

/**
 * The Library's Scoring guide: how a row and a job are scored, read from the rubric itself so the
 * guide cannot say something the arithmetic does not do. Nothing to fill in, and nothing it
 * describes gates a CV.
 */
export function EvidenceGuide() {
  return (
    <section className="space-y-4">
      <h2 className="ds-pixel text-12">Scoring guide</h2>
      <p className="text-14">Each row is scored against what its types need, and each job against the rows it holds.</p>
      <Table>
        <THead>
          <tr><TH>Type</TH><TH>A strong row says</TH><TH>Worth</TH></tr>
        </THead>
        <TBody>
          {EVIDENCE_FACETS_BY_NEED.map(facet => (
            <TR key={facet}>
              <TD className="font-semibold">{EVIDENCE_FACET_LABELS[facet]}</TD>
              <TD>{strongRowLine(facet)}</TD>
              <TD>{facetWorth(facet)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <div className="space-y-1 text-12 text-muted">
        <p>A row scores 25 for each of its type&apos;s four marks; a row with several types is scored against each and shown the mean.</p>
        <p>A job&apos;s rating is half the types its rows cover (Outcomes and Metrics moved count double) and half its rows&apos; average.</p>
        <p>None below 25 · Weak below 50 · Good below 75 · Strong from 75. Only confirmed rows reach a CV; the score describes the record and gates nothing.</p>
      </div>
    </section>
  );
}
