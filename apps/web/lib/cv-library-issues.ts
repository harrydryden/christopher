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
  status: "Status",
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

/** Every refusal in one sentence each, prefixed by what it is about. */
export function cvLibraryIssues(error: z.ZodError, submitted: unknown): string {
  const seen = new Set<string>();
  for (const issue of error.issues) {
    const where = cvLibraryIssueLabel(issue.path, submitted);
    seen.add(where ? `${where}: ${issue.message}` : issue.message);
  }
  return [...seen].join(" ");
}
