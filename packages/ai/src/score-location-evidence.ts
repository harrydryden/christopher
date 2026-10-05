import { createHash } from "node:crypto";
import { evaluateLocation } from "@col/core";
import { wrap } from "./prompts";

/** Maximum UTF-8 bytes devoted to the employer's location evidence in one A5 role. */
export const SCORE_LOCATION_EVIDENCE_BYTES = 12 * 1024;

const wrappedBytes = (text: string) => Buffer.byteLength(wrap("job", text)) - Buffer.byteLength(wrap("job", ""));

/**
 * Keep every place in the score input, but bound the part copied into a model request. Gate terms
 * identify literal/alias matches anywhere in the list; they are hints, not proof of eligibility.
 * A stable spread of other names avoids favouring the first page of an employer's location list.
 */
export function scoreLocationEvidence(locations: string[], locationTerms: string[] = []): string {
  const names = [...new Set(locations.map(name => name.trim().replace(/\s+/g, " ")).filter(Boolean))];
  const total = names.length;
  if (!total) return "";
  const all = names.join("; ");
  const complete = `Employer-listed locations (complete; total: ${total}; included: ${total}; omitted: 0): ${all}`;
  if (wrappedBytes(complete) <= SCORE_LOCATION_EVIDENCE_BYTES) return complete;

  const terms = locationTerms.map(term => term.trim()).filter(Boolean);
  const matched: string[] = [];
  const others: string[] = [];
  for (const name of names) {
    if (terms.length && evaluateLocation({ title: "", location: name }, { locationTerms: terms, includeRemote: false }).terms.length)
      matched.push(name);
    else others.push(name);
  }
  // Shorter matching names first retains more verified candidates when even the matches overflow.
  matched.sort((a, b) => wrappedBytes(a) - wrappedBytes(b) || a.localeCompare(b));
  const spread = others.map(name => ({ name, hash: createHash("sha256").update(name).digest("hex") }))
    .sort((a, b) => a.hash.localeCompare(b.hash) || a.name.localeCompare(b.name));

  const selected: string[] = [];
  let matchedIncluded = 0;
  // Leave ample room for counts and the uncertainty instruction, including large count values.
  const namesLimit = SCORE_LOCATION_EVIDENCE_BYTES - 512;
  let used = 0;
  for (const [index, name] of [...matched, ...spread.map(item => item.name)].entries()) {
    const extra = wrappedBytes(name) + (selected.length ? 2 : 0);
    if (used + extra > namesLimit) continue;
    selected.push(name);
    used += extra;
    if (index < matched.length) matchedIncluded++;
  }
  const omitted = total - selected.length;
  const matchedOmitted = matched.length - matchedIncluded;
  const heading = `Employer-listed locations (partial; total: ${total}; included: ${selected.length}; omitted: ${omitted}; matching configured terms omitted: ${matchedOmitted}): ${selected.join("; ") || "(none fit the evidence limit)"}`;
  const warning = "Location evidence incomplete: other verified employer-listed places are omitted. Configured location terms are selection hints, not eligibility or preference proof. Do not infer a location mismatch or ineligibility from omitted places.";
  const rendered = `${heading}\n${warning}`;
  if (wrappedBytes(rendered) > SCORE_LOCATION_EVIDENCE_BYTES) throw new Error("A5 location evidence exceeded its byte limit");
  return rendered;
}
