/**
 * The Library's Scoring guide: one row per type, read from the rubric, in the order the types are
 * worth the most, and the three lines that say how a row and a job are scored.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EVIDENCE_FACETS, EVIDENCE_FACET_LABELS } from "@col/core/cv-helpers";
import { LIBRARY_FACET_WEIGHTS } from "@col/core/library-review";
import { EvidenceGuide, facetWorth, strongRowLine } from "./EvidenceGuide";

const html = () => renderToStaticMarkup(<EvidenceGuide />);
const cells = (row: string) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]);

it("is headed in the pixel face with one lead sentence, and has no form fields", () => {
  const page = html();
  expect(page).toContain('<h2 class="ds-pixel text-12">Scoring guide</h2>');
  expect(page).toContain("Each row is scored against what its types need, and each job against the rows it holds.");
  expect(page).not.toMatch(/<(input|select|textarea|button)\b/);
});

it("lists every type as the Type column names it, worth first, with its four marks and its weight", () => {
  const page = html();
  expect([...page.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(match => match[1])).toEqual(["Type", "A strong row says", "Worth"]);
  const rows = [...page.matchAll(/<tr class="border-t[^"]*">([\s\S]*?)<\/tr>/g)].map(match => cells(match[1]!));
  expect(rows).toEqual([
    ["Outcomes", "the change stated · what produced it · who or what gained · the size of the change", "double"],
    ["Metrics moved", "the figure · what it measures · how it moved · what moved it, and when", "double"],
    ["Responsibilities", "what was owned · who it was for · your part in it · the size of it", "single"],
    ["Problems solved", "the problem named · what made it hard · what you did about it · how it ended", "single"],
    ["Milestones reached", "what was delivered · when it landed · your part in it · why it mattered", "single"],
    ["Working style", "the behaviour named · who with · one real instance · what it led to", "single"],
  ]);
  for (const facet of EVIDENCE_FACETS) {
    expect(page).toContain(`>${EVIDENCE_FACET_LABELS[facet]}<`);
    expect(page).toContain(`>${strongRowLine(facet)}<`);
  }
});

it("says double for exactly the types the job rating weights double", () => {
  // The guide cannot import the weights in a browser; this holds its word to them.
  for (const facet of EVIDENCE_FACETS) {
    expect(facetWorth(facet)).toBe(LIBRARY_FACET_WEIGHTS[facet] === 2 ? "double" : "single");
  }
});

it("explains the row score, the job rating and the bands under the table, as support text", () => {
  const page = html();
  const notes = page.slice(page.indexOf("</table>"));
  expect(notes).toContain('<div class="space-y-1 text-12 text-muted">');
  expect(notes).toContain("A row scores 25 for each of its type&#x27;s four marks; a row with several types is scored against each and shown the mean.");
  expect(notes).toContain("A job&#x27;s rating is half the types its rows cover (Outcomes and Metrics moved count double) and half its rows&#x27; average.");
  expect(notes).toContain("None below 25 · Weak below 50 · Good below 75 · Strong from 75. Only confirmed rows reach a CV; the score describes the record and gates nothing.");
});
