/**
 * What a document someone brought to the Library is allowed to become.
 *
 * A past CV, LinkedIn's own PDF of a profile, a personal website or pasted text is read once by a
 * model, which proposes employment, responsibilities, qualifications and skills. Nothing it
 * proposes is a fact until it is anchored: every company, job title, responsibility row,
 * qualification and skill has to appear in the document the person supplied, checked with
 * `cvQuoteIsAnchored` — the same NFKC, whitespace-normalised containment the CV review checks its
 * quotes with. What cannot be anchored is dropped and counted, never rewritten and never guessed
 * at, and a date the document does not carry stays blank rather than becoming a plausible one.
 *
 * That rule is the whole safety of the feature. An imported document is untrusted text: it may
 * contain instructions, and a model reading it may embellish a job title or round a figure. The
 * person is going to build CVs from what lands here and be asked about it in an interview, so the
 * product would rather propose less than propose something they never wrote.
 *
 * Nothing here writes to the Library. `proposalToLibraryAdditions` returns the library the person
 * would have if they accepted the items they ticked — additions only, with every new block active
 * and every row on it unconfirmed, so confirming those rows is the review step rather than a
 * second one.
 */
import { z } from "zod";
import {
  CvLibrarySchema,
  consolidateExperience,
  employmentHeading,
  responsibilityRows,
  type CvLibrary,
  type Employment,
} from "./cv";
import { cvQuoteIsAnchored } from "./cv-review";
import { assertPublicHttpUrl, UnsafeUrlError } from "./url-safety";

type CvEntry = CvLibrary["entries"][number];

/**
 * Text as a database and a model can both take it: every C0 control character and DEL removed,
 * except the tab and the line breaks that are a document's own layout. A PDF writes NUL for a
 * glyph it cannot map, and Postgres refuses NUL in a text column, so a document carrying one
 * failed on the write that followed the model call — and was paid for again on every retry.
 */
export function stripControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Shortest paste worth reading: less than this is a note, not a document. */
export const LIBRARY_IMPORT_MIN_CHARS = 100;

/** Jobs, qualifications and skills one document may propose. A CV longer than this is two imports. */
export const LIBRARY_IMPORT_MAX_JOBS = 20;
/** Rows one proposed job may carry, matching what the Library accepts per experience block. */
export const LIBRARY_IMPORT_MAX_ROWS = 20;
/** Skills one proposed block may carry, matching `SkillItemsSchema`. */
export const LIBRARY_IMPORT_MAX_SKILLS = 20;

/**
 * What the extraction returns, before anything is checked.
 *
 * Deliberately loose about content and strict about shape: a blank row or an over-long title is
 * dropped by `validateLibraryProposal` a moment later, and failing the whole parse over one of
 * them would throw away a document the person waited four minutes for. Every item is an object,
 * including a skill, so the proposal the validator writes back is the same shape it reads — which
 * is what lets an accepted proposal be anchored a second time against the stored document.
 */
export const LibraryProposalSchema = z.object({
  employment: z.array(z.object({
    company: z.string().max(400),
    title: z.string().max(400),
    /** `YYYY` or `YYYY-MM`, and only when the document says so. */
    startDate: z.string().max(40).nullable().optional(),
    endDate: z.string().max(40).nullable().optional(),
    current: z.boolean().nullable().optional(),
    quote: z.string().max(2000),
    responsibilities: z.array(z.object({
      text: z.string().max(4000),
      quote: z.string().max(4000),
    })).max(60).nullable().optional(),
  })).max(60),
  education: z.array(z.object({
    heading: z.string().max(400),
    detail: z.string().max(4000),
    quote: z.string().max(4000),
  })).max(60).nullable().optional(),
  skills: z.array(z.object({ text: z.string().max(200) })).max(60).nullable().optional(),
});
export type LibraryProposalPlan = z.infer<typeof LibraryProposalSchema>;

/** One responsibility a document supports, with the words it was read from. */
export interface ProposedRow {
  id: string;
  text: string;
  quote: string;
}
export interface ProposedJob {
  id: string;
  company: string;
  title: string;
  /** Blank unless the document carries the year. Never inferred from context. */
  startDate: string;
  endDate: string;
  current: boolean;
  quote: string;
  responsibilities: ProposedRow[];
}
export interface ProposedQualification {
  id: string;
  heading: string;
  detail: string;
  quote: string;
}
export interface ProposedSkill {
  id: string;
  text: string;
}

/** Everything one document proposes, each item with the id the accept controls name it by. */
export interface LibraryProposal {
  employment: ProposedJob[];
  education: ProposedQualification[];
  skills: ProposedSkill[];
}

/** The proposal as it is stored and read back: the same shape, with the ids the validator gave it. */
export const StoredLibraryProposalSchema = z.object({
  employment: z.array(z.object({
    id: z.string().min(1).max(100),
    company: z.string().min(1).max(160),
    title: z.string().min(1).max(160),
    startDate: z.string().max(7),
    endDate: z.string().max(7),
    current: z.boolean(),
    quote: z.string().max(2000),
    responsibilities: z.array(z.object({
      id: z.string().min(1).max(100),
      text: z.string().min(1).max(4000),
      quote: z.string().max(4000),
    })).max(LIBRARY_IMPORT_MAX_ROWS),
  })).max(LIBRARY_IMPORT_MAX_JOBS),
  education: z.array(z.object({
    id: z.string().min(1).max(100),
    heading: z.string().min(1).max(250),
    detail: z.string().min(1).max(4000),
    quote: z.string().max(4000),
  })).max(LIBRARY_IMPORT_MAX_JOBS),
  skills: z.array(z.object({ id: z.string().min(1).max(100), text: z.string().min(1).max(80) }))
    .max(LIBRARY_IMPORT_MAX_SKILLS),
});

const normalise = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const key = (value: string) => normalise(value).toLowerCase();

/** `YYYY` or `YYYY-MM`, which is every date `EmploymentSchema` accepts besides blank. */
const CAREER_DATE = /^(\d{4})(?:-(0[1-9]|1[0-2]))?$/;

/**
 * How many lines above and below a job's quote its heading may run — its employer, its dates, a
 * location or a duration — before a bullet, a blank line or another job's own line ends it.
 * LinkedIn's export puts the employer two lines above the title and the dates on the line below.
 */
const HEADING_LINES_BEFORE = 3;
const HEADING_LINES_AFTER = 2;

/** A line that is a list item rather than part of a heading. */
const LIST_ITEM = /^(?:[•\-*▪●◦‣·–—]|\d{1,2}[.)])\s/u;
const MONTH_NAMES = [
  ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"], ["may"], ["june", "jun"],
  ["july", "jul"], ["august", "aug"], ["september", "sept", "sep"], ["october", "oct"], ["november", "nov"], ["december", "dec"],
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A date the job's own heading carries, or as much of it as it carries, or nothing.
 *
 * Read from the passage around the job's quote, not from anywhere in the document: a year that
 * appears only on the education line is not this job's. The year has to be there as a year, and a
 * month has to be written beside it — "Mar 2020", "March 2020", "03/2020", "2020-03" — or the date
 * is kept to the year the heading does carry rather than a month the model supplied. Anything that
 * is not `YYYY` or `YYYY-MM` — a month name, a quarter, "present" — is left blank too, because
 * `EmploymentSchema` would refuse it and a half-parsed date is worse than an empty field the person
 * fills in themselves.
 */
function anchoredDate(value: string | null | undefined, passage: string): string {
  const trimmed = (value ?? "").trim();
  const match = CAREER_DATE.exec(trimmed);
  if (!match) return "";
  const [, year, month] = match;
  if (!new RegExp(`(?<!\\d)${year}(?!\\d)`).test(passage)) return "";
  if (!month) return year!;
  const number = Number(month);
  const named = MONTH_NAMES[number - 1]!.map(escapeRegExp).join("|");
  const written = [
    new RegExp(`\\b(?:${named})\\.?,?\\s?${year}(?!\\d)`, "i"),
    new RegExp(`(?<!\\d)0?${number}\\s?[/.\\-]\\s?${year}(?!\\d)`),
    new RegExp(`(?<!\\d)${year}\\s?[/.\\-]\\s?0?${number}(?!\\d)`),
  ];
  return written.some(pattern => pattern.test(passage)) ? trimmed : year!;
}

/**
 * A document as the lines it was written in, each normalised, so a passage can be read by line: a
 * job's heading is a few lines, not a count of characters that runs on into the next job.
 */
function documentLines(document: string) {
  const lines = document.split(/\r\n?|\n/).map(normalise);
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const flat = lines.join("\n");
  const lineAt = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  /** The lines `needle` is written across, wherever it appears, a line break counting as a space. */
  const find = (needle: string): Array<{ first: number; last: number }> => {
    if (!needle) return [];
    const pattern = new RegExp(escapeRegExp(needle).replace(/ /g, "[ \\n]"), "g");
    const found: Array<{ first: number; last: number }> = [];
    for (let match = pattern.exec(flat); match && found.length < 50; match = pattern.exec(flat)) {
      found.push({ first: lineAt(match.index), last: lineAt(match.index + match[0].length - 1) });
      pattern.lastIndex = match.index + 1;
    }
    return found;
  };
  const read = (first: number, last: number) => lines.slice(first, last + 1).join(" ");
  return { lines, find, read };
}

/**
 * A skill as a word the document writes, not a run of letters inside another one: "Go" is not
 * anchored by "Good communication", nor "SQL" by "NoSQL".
 */
function anchoredWord(text: string, document: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(text)}(?![\\p{L}\\p{N}])`, "u").test(document);
}

/** How many items a proposal holds, for the sentence the Library page opens the card with. */
export function countProposedItems(
  proposal: LibraryProposal,
  accepted?: Iterable<string>,
): { jobs: number; rows: number; education: number; skills: number } {
  const wanted = accepted ? new Set(accepted) : null;
  const take = (id: string) => !wanted || wanted.has(id);
  return {
    jobs: proposal.employment.filter(job => take(job.id)).length,
    rows: proposal.employment.filter(job => take(job.id))
      .reduce((total, job) => total + job.responsibilities.filter(row => take(row.id)).length, 0),
    education: proposal.education.filter(item => take(item.id)).length,
    skills: proposal.skills.filter(item => take(item.id)).length,
  };
}

/** Every id a proposal offers, in the order the card shows them. All of them start ticked. */
export function proposedItemIds(proposal: LibraryProposal): string[] {
  return [
    ...proposal.employment.flatMap(job => [job.id, ...job.responsibilities.map(row => row.id)]),
    ...proposal.education.map(item => item.id),
    ...proposal.skills.map(item => item.id),
  ];
}

/**
 * Keep what the document supports and drop the rest.
 *
 * A job is anchored as one passage, not as words found anywhere in the document: its quote has to
 * be in the document, its title and its employer within the heading around that quote, its dates
 * in that same heading, and each of its responsibilities — the row and its quote — between that
 * heading and the next job's. Checked one by one, a title from one line and an employer from
 * another made a job nobody had, a year from the education line dated a role, and a row was filed
 * under whichever job the model chose. An employer named once above several roles, as LinkedIn's
 * own export writes it, anchors each role under it until another employer's role comes between.
 *
 * A qualification survives when its heading, its detail and its quote are in the document; a skill
 * when the document writes it as a word. `dropped` counts every item that did not survive, because
 * "we read your CV and found nothing" and "we read your CV and refused six things it claimed" are
 * different sentences and the person is owed the second one.
 *
 * Idempotent: running it again over what it produced — against the same document — returns the
 * same proposal with the same ids, which is what lets an accepted item be anchored a second time
 * before it is written into the Library.
 */
export function validateLibraryProposal(
  documentText: string,
  value: unknown,
): { proposal: LibraryProposal; dropped: number } {
  const plan = LibraryProposalSchema.parse(value);
  const document = documentText ?? "";
  const text = normalise(document);
  const anchored = (value: string) => !!normalise(value) && cvQuoteIsAnchored(value, document);
  const within = (value: string, passage: string) => !!normalise(value) && passage.includes(normalise(value));
  let dropped = 0;

  const written = documentLines(document);
  const quotes = new Set(plan.employment.map(job => normalise(job.quote)).filter(Boolean));
  /** The lines heading a job whose quote is written across `first`–`last`. */
  const headingOf = (first: number, last: number, quote: string) => {
    const ends = (line: string | undefined) =>
      line === undefined || !line || LIST_ITEM.test(line) || (quotes.has(line) && line !== quote);
    let top = first;
    while (top > 0 && first - top < HEADING_LINES_BEFORE && !ends(written.lines[top - 1])) top--;
    let bottom = last;
    while (bottom - last < HEADING_LINES_AFTER && !ends(written.lines[bottom + 1])) bottom++;
    return { line: first, top, bottom, text: written.read(top, bottom) };
  };
  // Where each job is headed in the document: the first place its quote is written with its title
  // in the heading around it, preferring one whose heading names its employer too.
  const placed = plan.employment.map((job, order) => {
    const company = normalise(job.company).slice(0, 160);
    const title = normalise(job.title).slice(0, 160);
    const quote = normalise(job.quote);
    const headings = written.find(quote).map(place => headingOf(place.first, place.last, quote)).filter(place => within(title, place.text));
    const named = headings.find(place => within(company, place.text));
    const heading = named ?? headings[0];
    return { job, order, company, title, heading, named: named !== undefined };
  });
  // The employer of a role listed under another of the same employer's, read in document order.
  const byPosition = placed.filter(item => item.heading).sort((a, b) => a.heading!.line - b.heading!.line || a.order - b.order);
  const employed = new Set<number>();
  byPosition.forEach((item, index) => {
    const previous = byPosition[index - 1];
    if (item.named || (previous && employed.has(previous.order) && key(previous.company) === key(item.company))) employed.add(item.order);
  });
  /**
   * A job's passage: from its heading to the line before the next placed job's own line. Headings
   * can overlap — the lines above one job's title are the last lines of the job before — so the
   * boundary is the next job's quote, never the top of its heading.
   */
  const passageOf = (item: (typeof placed)[number]) => {
    const next = byPosition.find(other => other.heading!.line > item.heading!.line);
    return written.read(item.heading!.top, next ? next.heading!.line - 1 : written.lines.length - 1);
  };

  const employment: ProposedJob[] = [];
  const seenJobs = new Set<string>();
  for (const item of placed) {
    const { job, company, title } = item;
    const rows = job.responsibilities ?? [];
    if (!company || !item.heading || !employed.has(item.order)) {
      // The rows of a job that was never in the document go with it: they have nothing to hang on.
      dropped += 1 + rows.length;
      continue;
    }
    const passage = passageOf(item);
    const startDate = anchoredDate(job.startDate, item.heading.text);
    const current = job.current === true;
    const endDate = current ? "" : anchoredDate(job.endDate, item.heading.text);
    const jobKey = [key(company), key(title), startDate, endDate, String(current)].join("|");
    if (seenJobs.has(jobKey) || employment.length >= LIBRARY_IMPORT_MAX_JOBS) {
      dropped += 1 + rows.length;
      continue;
    }
    seenJobs.add(jobKey);
    const responsibilities: ProposedRow[] = [];
    const seenRows = new Set<string>();
    const id = `job-${employment.length}`;
    for (const row of rows) {
      const said = normalise(row.text).slice(0, 4000);
      if (!within(said, passage) || !within(row.quote, passage) || seenRows.has(key(said))
        || responsibilities.length >= LIBRARY_IMPORT_MAX_ROWS) {
        dropped += 1;
        continue;
      }
      seenRows.add(key(said));
      responsibilities.push({ id: `${id}-row-${responsibilities.length}`, text: said, quote: normalise(row.quote).slice(0, 4000) });
    }
    employment.push({ id, company, title, startDate, endDate, current, quote: normalise(job.quote).slice(0, 2000), responsibilities });
  }

  const education: ProposedQualification[] = [];
  const seenEducation = new Set<string>();
  for (const item of plan.education ?? []) {
    const heading = normalise(item.heading).slice(0, 250);
    const detail = normalise(item.detail).slice(0, 4000);
    if (!anchored(heading) || !anchored(detail) || !anchored(item.quote)
      || seenEducation.has(key(heading + detail)) || education.length >= LIBRARY_IMPORT_MAX_JOBS) {
      dropped += 1;
      continue;
    }
    seenEducation.add(key(heading + detail));
    education.push({ id: `education-${education.length}`, heading, detail, quote: normalise(item.quote).slice(0, 4000) });
  }

  const skills: ProposedSkill[] = [];
  const seenSkills = new Set<string>();
  for (const item of plan.skills ?? []) {
    const skill = normalise(item.text);
    if (!skill || skill.length > 80 || !anchoredWord(skill, text) || seenSkills.has(key(skill))
      || skills.length >= LIBRARY_IMPORT_MAX_SKILLS) {
      dropped += 1;
      continue;
    }
    seenSkills.add(key(skill));
    skills.push({ id: `skill-${skills.length}`, text: skill });
  }

  return { proposal: { employment, education, skills }, dropped };
}

/**
 * Sites the product will not fetch a profile from, whatever the person pastes.
 *
 * LinkedIn is the one that matters: it is where a career actually lives, its terms forbid
 * crawling it, and its pages are behind an authwall the polite fetcher would be refused by
 * anyway. The answer is not a cleverer fetch — it is LinkedIn's own "Save to PDF" of the profile,
 * uploaded like any other document, which is what `LINKEDIN_IMPORT_ADVICE` says. The job boards
 * are here for the same reason they are excluded from company suggestions: an aggregator's page
 * about someone is not the person's own writing.
 */
export const LIBRARY_IMPORT_BLOCKED_HOSTS: readonly string[] = [
  "linkedin.com", "indeed.com", "indeed.co.uk", "glassdoor.com", "glassdoor.co.uk", "monster.com",
  "ziprecruiter.com", "totaljobs.com", "reed.co.uk", "otta.com", "welcometothejungle.com",
  "wellfound.com", "angel.co", "xing.com",
];

/** What to do instead, in one sentence, wherever a LinkedIn URL is refused. */
export const LINKEDIN_IMPORT_ADVICE =
  "AVA does not read LinkedIn. Open your profile, choose More \u2192 Save to PDF, and upload that file here.";

/**
 * The person's own site, checked before anything fetches it: https, a public host, no
 * credentials, and none of the sites above. Returns the URL to store, or the sentence to show them.
 */
export function libraryImportUrl(value: string): { url: string } | { error: string } {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed.length > 2048) return { error: "Enter the address of a page about you, up to 2,048 characters." };
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { error: "That does not look like a web address. Paste the whole link, starting with https://." };
  }
  if (parsed.protocol !== "https:") return { error: "Use an https:// address, so the page is fetched securely." };
  if (parsed.username || parsed.password) return { error: "Remove the username and password from the address." };
  // The same guard every fetch the worker makes goes through: a page about you is on the public
  // internet, and an address inside a private network is refused here in words, before it is stored.
  try {
    assertPublicHttpUrl(parsed);
  } catch (error) {
    if (error instanceof UnsafeUrlError) return { error: `${error.message}. Use the address of your own public page, or upload a document instead.` };
    throw error;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".")) return { error: "That does not look like a web address. Paste the whole link, starting with https://." };
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return { error: LINKEDIN_IMPORT_ADVICE };
  if (LIBRARY_IMPORT_BLOCKED_HOSTS.some(blocked => host === blocked || host.endsWith(`.${blocked}`)))
    return { error: "That is a job site rather than your own page. Use your own website, or upload a document instead." };
  return { url: parsed.toString() };
}

export interface LibraryAdditionOptions {
  /** Namespace for the ids of the blocks this import creates, so two imports never collide. */
  prefix?: string;
  /** Used only when the account has no library yet and the schema needs a name on it. */
  name?: string;
  contact?: string;
}

/** An empty library has no entries, which is one fewer than the schema accepts; it is never saved alone. */
const EMPTY: CvLibrary = { name: "", contact: "", profile: "", structuredExperience: true, employment: [], entries: [] } as unknown as CvLibrary;

/**
 * The library the person would have if they accepted the items they ticked.
 *
 * Additions only. Nothing that was already in the library is removed, reworded or re-confirmed:
 * an existing job keeps its block and gains the accepted rows it does not already have, and a job
 * the library has never heard of arrives as a block of its own with every row unconfirmed. The
 * block is active, because the job is in employment history and there is no status to set; what
 * makes a row usable is the person asserting that it is true of them, exactly as it is for a row
 * they typed themselves.
 *
 * A responsibility whose job was not accepted is not added: the row belongs to the job, and a
 * library cannot carry evidence for an employer it does not list.
 */
export function proposalToLibraryAdditions(
  existingLibrary: CvLibrary | null | undefined,
  proposal: LibraryProposal,
  acceptedIds: Iterable<string>,
  options: LibraryAdditionOptions = {},
): { library: CvLibrary; added: { jobs: number; rows: number; education: number; skills: number } } {
  const prefix = options.prefix?.trim() || "import";
  const accepted = new Set(acceptedIds);
  const base = existingLibrary
    ? consolidateExperience(existingLibrary)
    : { ...EMPTY, name: (options.name ?? "").trim(), contact: (options.contact ?? "").trim() };
  const employment: Employment[] = [...(base.employment ?? [])];
  const entries: CvEntry[] = [...base.entries];
  const added = { jobs: 0, rows: 0, education: 0, skills: 0 };

  for (const job of proposal.employment) {
    if (!accepted.has(job.id)) continue;
    const wanted = job.responsibilities.filter(row => accepted.has(row.id));
    // The same employer, job title and dates is the same job: the library already lists it, and a
    // second copy would fail `EmploymentSchema`'s own uniqueness rule rather than add anything.
    let record = employment.find(item =>
      key(item.company) === key(job.company) && key(item.jobTitle) === key(job.title)
      && item.startDate === job.startDate && item.endDate === job.endDate && item.current === job.current);
    if (!record) {
      record = {
        id: `${prefix}:${job.id}`,
        company: job.company,
        jobTitle: job.title,
        startDate: job.startDate,
        endDate: job.endDate,
        current: job.current,
      };
      employment.push(record);
      added.jobs += 1;
    }
    if (!wanted.length) continue;
    const index = entries.findIndex(entry => entry.kind === "experience" && entry.employmentId === record!.id);
    const existing = index === -1 ? null : entries[index]!;
    const held = new Set(responsibilityRows(existing?.details ?? "").map(key));
    const rows: string[] = [];
    for (const row of wanted) {
      if (held.has(key(row.text)) || held.size + rows.length >= LIBRARY_IMPORT_MAX_ROWS) continue;
      rows.push(row.text);
    }
    if (!rows.length) continue;
    added.rows += rows.length;
    if (existing) {
      // Appended, never rewritten: the rows that were there keep their wording and their
      // confirmations, and the new ones arrive unconfirmed under them.
      entries[index] = { ...existing, details: [...responsibilityRows(existing.details), ...rows].join("\n") };
    } else {
      entries.push({
        id: `${prefix}:${job.id}:evidence`,
        kind: "experience",
        status: "active",
        heading: employmentHeading(record),
        details: rows.join("\n"),
        employmentId: record.id,
        confirmedResponsibilities: [],
      });
    }
  }

  for (const item of proposal.education) {
    if (!accepted.has(item.id)) continue;
    if (entries.some(entry => entry.kind === "education" && key(entry.heading) === key(item.heading)
      && key(entry.details) === key(item.detail))) continue;
    entries.push({ id: `${prefix}:${item.id}`, kind: "education", status: "active", heading: item.heading, details: item.detail });
    added.education += 1;
  }

  const held = new Set(entries.flatMap(entry => [...(entry.skillItems ?? []), ...responsibilityRows(entry.kind === "skill" ? entry.details : "")].map(key)));
  const skills = proposal.skills.filter(item => accepted.has(item.id) && !held.has(key(item.text))).map(item => item.text);
  if (skills.length) {
    const items = skills.slice(0, LIBRARY_IMPORT_MAX_SKILLS);
    added.skills = items.length;
    entries.push({
      id: `${prefix}:skills`,
      kind: "skill",
      status: "active",
      heading: "Skills",
      details: items.join("\n"),
      skillItems: items,
    });
  }

  return { library: { ...base, structuredExperience: true, employment, entries }, added };
}

/**
 * The same additions, parsed. A caller that is about to save goes through here so an import can
 * never write a library the editor would refuse — and so the refusal, when it comes, comes before
 * anything is versioned.
 */
export function parseLibraryAdditions(library: CvLibrary): CvLibrary {
  return CvLibrarySchema.parse(consolidateExperience(library));
}
