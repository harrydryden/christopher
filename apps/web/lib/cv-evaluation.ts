import { cvContentLinks, cvLibraryJobFor, type CvContentLink } from "./cv-content-links";
import { cvShareAnchorLabel, type CvShareCommentLike } from "./cv-share";
import type { CvContent, CvLibrary } from "@christopher/core/cv";
import {
  cvClaimItems,
  cvImprovementOwner,
  type CvAssessment,
} from "@christopher/core/cv-assessment";

export const CV_CHANGE_TYPES = [
  "None",
  "Fact",
  "Gap",
  "Improvement",
  "Uncertain",
  // Not the reviewer's finding but a person's: a note left through a share link, filed against
  // the same block ids the assessment cites, so the two sit in one table.
  "Comment",
] as const;
export type CvChange = (typeof CV_CHANGE_TYPES)[number];
export type CvEvaluationRow = {
  id: string;
  requirement: string;
  importance?: string;
  category?: "experience" | "skills" | "education" | "delivery" | "logistics";
  currentText: string[];
  change: CvChange;
  suggestion: string;
  contentLinks: CvContentLink[];
  evidence: "None" | "Weak" | "Good" | "Strong";
  experience: "None" | "Weak" | "Good" | "Strong";
  reason: string;
  companyText?: string;
  sources: string[];
  /**
   * Where to go to close this gap: the Library, with the need quoted and — when the row cites one
   * job and only one — that job in hand. Absent on a row with nothing missing.
   */
  libraryHref?: string;
};
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/** Enough of the need to recognise it in the Library, short enough to travel in a link. */
const NEED_CHARACTERS = 300;

/** A row is worth a trip to the Library when something is missing rather than merely rewritable. */
function needsLibraryEvidence(row: Pick<CvEvaluationRow, "change" | "evidence">): boolean {
  // A reader's note rates nothing, so its empty Evidence cell must not be read as a gap and sent
  // to the Library. What to do about a comment is the comment's to say.
  if (row.change === "Comment") return false;
  return row.change === "Gap" || row.evidence === "None" || row.evidence === "Weak";
}

/**
 * What to quote back to the person in the Library: the company's requirement for a row that has
 * one, and the guidance itself for the rows written without a requirement behind them — the
 * factual concerns and the writer's own gaps, whose "requirement" is a heading, not a need.
 */
function needText(row: CvEvaluationRow): string {
  const generated = row.id.startsWith("gap:") || row.id.startsWith("claim:");
  return ((generated ? row.suggestion : row.requirement) || row.requirement).trim();
}

/**
 * The link behind "Add evidence for this" (4.3), or undefined when the row has no gap to close.
 *
 * `need` is the Library's prompt, cut rather than summarised so the wording stays the reviewer's.
 * `job` is added only when the row's own content links resolve to exactly one job in employment
 * history, which is the only mapping from a CV block back to the Library that is not a guess.
 */
export function cvLibraryHref(row: CvEvaluationRow, library?: Pick<CvLibrary, "entries"> | null): string | undefined {
  if (!needsLibraryEvidence(row)) return undefined;
  const need = needText(row).slice(0, NEED_CHARACTERS);
  if (!need) return undefined;
  const job = cvLibraryJobFor(row.contentLinks, library);
  return `/library?need=${encodeURIComponent(need)}${job ? `&job=${encodeURIComponent(job)}` : ""}`;
}

/**
 * "Your Library changed since this build (v7 → v9)." — or null while the build is written from
 * the Library as it stands. The versions come from the draft's own snapshot and the account's
 * latest saved Library, so the sentence names the two things a rebuild would move between.
 */
export function libraryDriftSentence(
  draftVersion: number | null | undefined,
  latestVersion: number | null | undefined,
): string | null {
  if (!draftVersion || !latestVersion || latestVersion <= draftVersion) return null;
  return `Your Library changed since this build (v${draftVersion} → v${latestVersion}).`;
}


/** One reader's note, as the owner's table needs it. */
export interface CvCommentInput extends CvShareCommentLike {
  id: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

/**
 * Open notes, one row per block, newest block first.
 *
 * A note is not a finding: it rates nothing, it cites no requirement, and it cannot be closed by
 * writing something in the Library. So the row carries the count, the latest note as its guidance
 * and a link to the block, and is shown unrated in the two strength columns — the reader is a
 * person with an opinion, not a second assessment.
 */
export function cvCommentRows(comments: CvCommentInput[], content: CvContent | null): CvEvaluationRow[] {
  const open = comments.filter((comment) => !comment.resolvedAt);
  const byAnchor = new Map<string, CvCommentInput[]>();
  for (const comment of open) byAnchor.set(comment.anchor, [...(byAnchor.get(comment.anchor) ?? []), comment]);
  return [...byAnchor.entries()]
    .map(([anchor, notes]) => {
      const ordered = [...notes].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const latest = ordered[0]!;
      const label = cvShareAnchorLabel(anchor, content);
      return {
        row: {
          id: `comment:${anchor}`,
          requirement: label,
          currentText: [],
          change: "Comment" as const,
          suggestion: `${ordered.length} open ${ordered.length === 1 ? "note" : "notes"} from readers of your shared link. ${latest.authorName}: ${latest.body}`,
          contentLinks: [{ id: anchor, label }],
          evidence: "None" as const,
          experience: "None" as const,
          reason: "Left by a reader on a shared preview of this revision. Resolve it under Comments from readers.",
          sources: ordered.slice(1).map((note) => `${note.authorName}: ${note.body}`),
        },
        at: latest.createdAt.getTime(),
      };
    })
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.row);
}

/**
 * Presentation of the saved assessment only; never generates new claims or changes its score.
 *
 * `library` is the revision's own snapshot, and is used for one thing: deciding which job in
 * employment history a row's gap belongs to, so "Add evidence for this" can open it.
 *
 * `comments` are the notes left through this CV's share links. They are appended rather than
 * merged: a reader's opinion sits in the same table as the reviewer's findings, and is never
 * allowed to change one.
 */
export function cvEvaluationRows(
  assessment: CvAssessment,
  content: CvContent | null,
  library?: Pick<CvLibrary, "entries"> | null,
  comments: CvCommentInput[] = [],
): CvEvaluationRow[] {
  const claims = new Map(
    assessment.review.claims.map((claim) => [claim.claimId, claim]),
  );
  const texts = new Map(
    content ? cvClaimItems(content).map((item) => [item.id, item.text]) : [],
  );
  const matches = new Map(
    assessment.review.matches.map((match) => [match.requirementId, match]),
  );
  const factualClaims = [...claims.values()].filter(
    (claim) => claim.status !== "supported",
  );
  const factualItemNumbers = new Map(
    factualClaims.map((claim, index) => [
      claim.claimId,
      assessment.rubric.requirements.length + index + 1,
    ]),
  );
  const rows: CvEvaluationRow[] = assessment.rubric.requirements.map(
    (requirement) => {
      const match = matches.get(requirement.id);
      if (!match)
        return {
          id: requirement.id,
          requirement: requirement.label,
          importance: requirement.importance,
          category: requirement.category,
          currentText: [],
          change: "Uncertain",
          suggestion: "Reassess this revision to review this requirement.",
          contentLinks: [],
          evidence: "None",
          experience: "Weak",
          reason: "No requirement assessment is available.",
          companyText: requirement.quote,
          sources: [],
        };
      const flags = unique(match.cvEvidence.map((ref) => ref.id)).flatMap(
        (id) => {
          const claim = claims.get(id);
          if (!claim || claim.status === "supported") return [];
          return [claim];
        },
      );
      const unsupported = flags.some((claim) => claim.status === "unsupported");
      const unreviewed = match.cvEvidence.some(
        (ref) => !ref.id.endsWith(":heading") && !claims.has(ref.id),
      );
      const uncertain =
        flags.length > 0 || unreviewed || match.status === "unknown";
      const demonstrated =
        match.status === "demonstrated" && match.cvEvidence.length > 0;
      const owner = cvImprovementOwner(match);
      const change: CvChange = unsupported
        ? "Fact"
        : flags.length > 0 || unreviewed
          ? "Uncertain"
          : demonstrated
            ? "None"
            : owner === "system"
              ? "Improvement"
              : uncertain
                ? "Uncertain"
                : "Gap";
      return {
        id: requirement.id,
        requirement: requirement.label,
        importance: requirement.importance,
        category: requirement.category,
        currentText: unique(match.cvEvidence.map((ref) => ref.quote)),
        change,
        suggestion: flags.length
          ? `Resolve the factual concern in ${flags.length === 1 ? "item" : "items"} ${flags.map((claim) => factualItemNumbers.get(claim.claimId)).join(", ")}. ${match.improvement || "Confirm the evidence or revise the wording, then reassess."}`
          : unreviewed
            ? "This wording needs factual review. Reassess the saved revision."
            : change === "None"
              ? "No change needed."
              : match.improvement || match.reason,
        contentLinks: cvContentLinks(
          content,
          [...match.cvEvidence, ...match.libraryEvidence].map((ref) => ref.id),
        ),
        evidence: !match.libraryEvidence.length
          ? "None"
          : match.libraryStatus === "demonstrated"
            ? "Strong"
            : match.libraryStatus === "partial"
              ? "Good"
              : "Weak",
        experience: unsupported
          ? "None"
          : uncertain
            ? "Weak"
            : demonstrated
              ? "Strong"
              : match.status === "partial"
                ? "Good"
                : "None",
        reason: match.reason,
        companyText: requirement.quote,
        sources: unique(match.libraryEvidence.map((ref) => ref.quote)),
      };
    },
  );
  // Explain each factual concern once, including those not cited by a requirement.
  for (const claim of factualClaims) {
    rows.push({
      id: `claim:${claim.claimId}`,
      requirement: "Factual accuracy",
      currentText: [texts.get(claim.claimId) ?? "Saved claim text unavailable"],
      change: claim.status === "unsupported" ? "Fact" : "Uncertain",
      suggestion: `${claim.reason} Confirm supporting evidence or revise the wording, then reassess.`,
      contentLinks: cvContentLinks(content, [claim.claimId]),
      evidence: claim.evidence.length ? "Weak" : "None",
      experience: claim.status === "unsupported" ? "None" : "Weak",
      reason: claim.reason,
      sources: unique(claim.evidence.map((ref) => ref.quote)),
    });
  }
  // Authoring gaps have no requirement IDs; retain them without guessing semantic matches.
  for (const [index, gap] of unique(content?.gaps ?? []).entries()) {
    if (rows.some((row) => row.suggestion === gap || row.reason === gap))
      continue;
    rows.push({
      id: `gap:${index}`,
      requirement: "Additional evidence",
      currentText: [],
      change: "Gap",
      suggestion: gap,
      contentLinks: [],
      evidence: "None",
      experience: "None",
      reason: "Identified during writing and excluded from the PDF.",
      sources: [],
    });
  }
  // The way out of every gap, added once the rows are built so each kind is judged the same way.
  return [...rows, ...cvCommentRows(comments, content)].map((row) => {
    const libraryHref = cvLibraryHref(row, library);
    return libraryHref ? { ...row, libraryHref } : row;
  });
}
