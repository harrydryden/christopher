/**
 * The revision a CV's improvement pass adopted, read from its build ledger.
 *
 * Apart from the narrative (lib/cv-build-narrative.ts) because a finished CV's page shows the link
 * to that revision above its build log without telling the log: the narrative is loaded only when
 * the log is opened, and this is all the page needs before then.
 */
import type { CvJournalStep } from "./cv-build-journal";
import { formatCount } from "./format";

const text = (detail: Record<string, unknown>, key: string): string | null => {
  const value = detail[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/** The adopted revision's name: the worker's label, the page's, or its revision number. */
export function revisionName(detail: Record<string, unknown>): string | null {
  const label = text(detail, "label");
  if (label) return label;
  const revision = detail.revision;
  if (typeof revision === "string" && revision.trim()) return revision.trim();
  if (typeof revision === "number" && Number.isFinite(revision)) return `revision ${formatCount(revision)}`;
  return null;
}

/** The revision the improvement pass adopted, once it has, for the link above the log. */
export function adoptedRevision(steps: readonly CvJournalStep[]): { name: string | null; draftId: string | null } | null {
  const adopted = [...steps].reverse().find((step) => step.motion === "adopt_revision" && step.status === "done");
  if (!adopted) return null;
  // TODO(merge P2): the adopted revision's draft id; `revision` is its name or number.
  const draftId = text(adopted.detail, "draftId") ?? text(adopted.detail, "revisionId");
  return { name: revisionName(adopted.detail), draftId };
}
