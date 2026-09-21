/**
 * A refused Library save, named the way the person named it.
 *
 * Zod reports a path — `employment.2.startDate` — and the editor used to repeat it as "Job 3
 * (startDate)". Nobody counts their jobs, and the array index is not the order on the screen once
 * the experience panel groups by company, so the refusal pointed at the wrong row as often as not.
 * These names come from the submitted value itself: the company and title of the job, or the
 * evidence block's own label, with the index kept only when there is nothing to read.
 *
 * The submitted value is untrusted — it is whatever the browser posted — so nothing is read from it
 * except short strings, truncated, and anything unreadable falls back to the index.
 */
import type { z } from "zod";

/** The refusal core raises when two jobs in employment history are the same job. */
const DUPLICATE_JOB = "This company, job title and date range already exist in employment history.";

/**
 * What that refusal means when the job it collides with was removed.
 *
 * A removed job keeps its employment record — the evidence archived with it has to point at
 * something — so retyping it is refused by a rule about a row the person cannot see. Replaced
 * rather than prefixed: "already exist in employment history" is precisely the part that is not
 * true of anything on the screen, and repeating it is what made the refusal unanswerable.
 */
const RESTORE_INSTEAD = "This job is in Archived jobs below; restore it instead of adding it again.";

/** The field labels the editor puts above its controls. */
const FIELDS: Record<string, string> = {
  name: "Name",
  contact: "Contact details",
  profile: "Career overview",
  linkedinUrl: "LinkedIn",
  websiteUrl: "Website",
  company: "Company",
  jobTitle: "Job title",
  startDate: "Start date",
  endDate: "End date",
  current: "Current",
  industryDescriptions: "Industry descriptions",
  heading: "Evidence label",
  details: "Details",
  skillItems: "Individual skills",
  confirmedResponsibilities: "Confirmed rows",
  rowFacets: "Row types",
  // Not a control any more: a block is archived by removing its job, and put back from the
  // Archived jobs list. The name is what the person would look for if one were ever refused.
  status: "Archived",
  kind: "Type",
  employmentId: "Employment link",
  employment: "Employment history",
  entries: "Evidence blocks",
  stylePreferences: "Writing style",
  preferredWording: "Saved phrasing",
};

const text = (value: unknown, max = 80): string =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "";

const at = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

const row = (value: unknown, collection: string, index: number): unknown => {
  const list = at(value, collection);
  return Array.isArray(list) ? list[index] : undefined;
};

/** "Northwind Health · Head of Operations", or "Job 3" when the row says nothing yet. */
function jobName(submitted: unknown, index: number): string {
  const job = row(submitted, "employment", index);
  const named = [text(at(job, "company")), text(at(job, "jobTitle"))].filter(Boolean).join(" · ");
  return named || `Job ${index + 1}`;
}

/** An evidence block by its label, or by the job it belongs to, or by its position. */
function entryName(submitted: unknown, index: number): string {
  const entry = row(submitted, "entries", index);
  const heading = text(at(entry, "heading"));
  if (heading) return heading;
  const employmentId = at(entry, "employmentId");
  const employment = at(submitted, "employment");
  if (employmentId && Array.isArray(employment)) {
    const position = employment.findIndex(job => at(job, "id") === employmentId);
    if (position >= 0) return jobName(submitted, position);
  }
  return `Evidence ${index + 1}`;
}

/** Where an issue happened, in the editor's own words. */
export function cvLibraryIssueLabel(path: readonly PropertyKey[], submitted: unknown): string {
  const [section, index, field] = path;
  if (typeof section !== "string") return "";
  if ((section === "employment" || section === "entries") && typeof index === "number") {
    const who = section === "employment" ? jobName(submitted, index) : entryName(submitted, index);
    const what = typeof field === "string" ? FIELDS[field] ?? field : undefined;
    return what ? `${who} (${what})` : who;
  }
  return FIELDS[section] ?? section;
}

/** The key core compares two jobs by: the company and the title as text, and the dates exactly. */
const employmentKey = (job: unknown): string => JSON.stringify([
  text(at(job, "company"), 160).replace(/\s+/g, " ").toLowerCase(),
  text(at(job, "jobTitle"), 160).replace(/\s+/g, " ").toLowerCase(),
  at(job, "startDate"),
  at(job, "endDate"),
  at(job, "current"),
]);

/**
 * Whether the job a duplicate refusal is about is one that was removed rather than one on screen.
 *
 * Removal archives a job's evidence and keeps the employment record under it, so a person who
 * removes a job and types it back in collides with a record that is real, stored and invisible.
 * The advice only applies when one side of the collision is that record and the other is not:
 * two jobs both on the screen are an ordinary duplicate and the plain refusal is the right one.
 *
 * The submitted value is untrusted, so every field is read defensively and anything unreadable
 * simply fails to match.
 */
function duplicatesArchivedJob(submitted: unknown): boolean {
  const employment = at(submitted, "employment");
  const entries = at(submitted, "entries");
  if (!Array.isArray(employment) || !Array.isArray(entries)) return false;
  const archived = new Set<string>();
  const shown = new Set<string>();
  for (const entry of entries) {
    const employmentId = at(entry, "employmentId");
    if (at(entry, "kind") !== "experience" || typeof employmentId !== "string") continue;
    (at(entry, "status") === "inactive" ? archived : shown).add(employmentId);
  }
  const removed = (job: unknown) => {
    const id = at(job, "id");
    return typeof id === "string" && archived.has(id) && !shown.has(id);
  };
  const groups = new Map<string, unknown[]>();
  for (const job of employment) groups.set(employmentKey(job), [...(groups.get(employmentKey(job)) ?? []), job]);
  return [...groups.values()].some(group => group.length > 1 && group.some(removed) && group.some(job => !removed(job)));
}

/** Every refusal in one sentence each, prefixed by what it is about. */
export function cvLibraryIssues(error: z.ZodError, submitted: unknown): string {
  const seen = new Set<string>();
  // Read once, and only when there is a duplicate to explain.
  const restorable = error.issues.some(issue => issue.message === DUPLICATE_JOB) && duplicatesArchivedJob(submitted);
  for (const issue of error.issues) {
    const message = restorable && issue.message === DUPLICATE_JOB ? RESTORE_INSTEAD : issue.message;
    const where = cvLibraryIssueLabel(issue.path, submitted);
    seen.add(where ? `${where}: ${message}` : message);
  }
  return [...seen].join(" ");
}
