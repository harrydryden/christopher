/**
 * Bringing a document into the Library, against the database.
 *
 * Three things are being held in place. What the interface refuses, it refuses before anything is
 * stored — a paste that is too long, a file that is too large or is not a document, a LinkedIn
 * URL — because the alternative is a check constraint or four minutes of waiting. The same
 * document twice is one import. And accepting items goes through the Library's own save, so the
 * version moves, a library that changed underneath is refused, and what lands is drafts with
 * nothing confirmed.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, createLibraryImport, getLibraryImport, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import type { User } from "@ava/db/schema";
import { runMigrations } from "@ava/db/migrate";
import { renderCvPdf } from "@ava/core/cv-pdf";
import { responsibilityRows, type CvLibrary } from "@ava/core";
import { desc, eq, sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
const auth = vi.hoisted(() => ({ requireUser: vi.fn(), requireSession: vi.fn(), requireVerifiedUser: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import { acceptLibraryImport, dismissLibraryImport, importLibraryDocument, retryLibraryImport } from "./library-import";

const ROWS = {
  moved: "Ran the UK warehouse team of 30 through a move to a new site",
  handover: "Cut handover time from two days to four hours",
};
const DOCUMENT = [
  "Jane Okafor — Operations leader",
  "Director of Operations, Acme Logistics, Mar 2020 – Jun 2022",
  `• ${ROWS.moved}`,
  `• ${ROWS.handover}`,
  "MSc Operations Management, University of Leeds, 2014",
].join("\n");

/** A proposal as the worker writes one: anchored in the document above. */
const PROPOSAL = {
  employment: [{
    id: "job-0", company: "Acme Logistics", title: "Director of Operations", startDate: "2020-03", endDate: "2022-06",
    current: false, quote: "Director of Operations, Acme Logistics, Mar 2020 – Jun 2022",
    responsibilities: [
      { id: "job-0-row-0", text: ROWS.moved, quote: ROWS.moved },
      { id: "job-0-row-1", text: ROWS.handover, quote: ROWS.handover },
    ],
  }],
  education: [{ id: "education-0", heading: "University of Leeds", detail: "MSc Operations Management, University of Leeds, 2014", quote: "MSc Operations Management" }],
  skills: [],
};

function form(values: Record<string, string | string[] | File>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item as string);
  }
  return data;
}

const tasks = () => database.select().from(schema.tasks);
const imports = () => database.select().from(schema.libraryImports);
const latestLibrary = async () =>
  (await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, user.id)).orderBy(desc(schema.cvLibraries.version)).limit(1))[0];

/** An import the worker has already read, with its proposal on it. */
async function proposed(overrides: { content?: string; proposal?: unknown } = {}) {
  const row = await createLibraryImport(database, { userId: user.id, kind: "paste", content: overrides.content ?? DOCUMENT });
  await database.update(schema.libraryImports)
    .set({ proposal: overrides.proposal ?? PROPOSAL, processedAt: new Date() })
    .where(eq(schema.libraryImports.id, row.id));
  return row;
}

async function saveLibrary(content: CvLibrary, version = 1) {
  await database.insert(schema.cvLibraries).values({ userId: user.id, version, content });
}

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  user = await ensureTestUser(database, "library-import-action@example.com");
  other = await ensureTestUser(database, "library-import-stranger@example.com", "member");
});

afterAll(async () => {
  // The accounts this file opened go with it: the web suites share one database and run one
  // file at a time, and a user left behind gives the next file's daily tick somebody to queue
  // weekly work for.
  if (database) await database.execute(sql`truncate library_imports, cv_libraries, tasks, users cascade`);
  await pool?.end();
});

beforeEach(async () => {
  auth.requireUser.mockReset(); auth.requireUser.mockImplementation(async () => user);
  auth.requireSession.mockReset(); auth.requireSession.mockImplementation(async () => user);
  auth.requireVerifiedUser.mockReset(); auth.requireVerifiedUser.mockImplementation(async () => auth.requireUser());
  await database.execute(sql`truncate library_imports, cv_libraries, tasks, user_settings restart identity cascade`);
});

it("refuses a paste that is too short or too long before anything is stored", async () => {
  expect(await importLibraryDocument(form({ kind: "paste", content: "Operations." })))
    .toMatchObject({ ok: false, error: expect.stringContaining("at least 100 characters") });
  expect(await importLibraryDocument(form({ kind: "paste", content: "Ran operations. ".repeat(3000) })))
    .toMatchObject({ ok: false, error: expect.stringContaining("40,000 characters") });
  expect(await importLibraryDocument(form({ kind: "nonsense", content: DOCUMENT })))
    .toMatchObject({ ok: false });

  expect(await imports()).toHaveLength(0);
  expect(await tasks()).toHaveLength(0);
});

it("stores a pasted CV, queues one reading of it, and recognises the same document again", async () => {
  const result = await importLibraryDocument(form({ kind: "paste", content: DOCUMENT }));

  expect(result).toMatchObject({ ok: true, message: expect.stringContaining("reading your document") });
  const [row] = await imports();
  expect(row).toMatchObject({ userId: user.id, kind: "paste", content: DOCUMENT, processedAt: null, resolvedAt: null });
  const queued = await tasks();
  expect(queued.map(task => [task.type, task.dedupeKey, task.priority]))
    .toEqual([["import_library_document", `import_library_document:${row!.id}`, 1]]);
  expect(queued[0]!.payload).toEqual({ userId: user.id, importId: row!.id });

  // The same words again: one import, one task, and a sentence that says so.
  expect(await importLibraryDocument(form({ kind: "paste", content: DOCUMENT })))
    .toMatchObject({ ok: true, message: expect.stringContaining("already imported") });
  expect(await imports()).toHaveLength(1);
  expect(await tasks()).toHaveLength(1);
});

it("revalidates the Library on every way an import succeeds, so the form needs no refresh of its own", async () => {
  // The form relies on the action's own response to carry the re-rendered page, which Next
  // sends only when the action revalidates.
  const revalidated = vi.mocked(revalidatePath);
  const succeeds = async (message: string) => {
    revalidated.mockClear();
    expect(await importLibraryDocument(form({ kind: "paste", content: DOCUMENT })))
      .toMatchObject({ ok: true, message: expect.stringContaining(message) });
    expect(revalidated.mock.calls).toEqual([["/library"]]);
  };
  await succeeds("reading your document");
  await succeeds("It is still being read");
  await database.update(schema.libraryImports).set({ proposal: PROPOSAL, processedAt: new Date() });
  await succeeds("What was found in it is below");
  const [row] = await imports();
  revalidated.mockClear();
  expect((await dismissLibraryImport(row!.id)).ok).toBe(true);
  expect(revalidated.mock.calls).toEqual([["/library"]]);
  await succeeds("reading it again");
});

it("says where the first import of the same document got to, and reads it again once it is finished with", async () => {
  // Read, proposed, and still on the page: what was found is already in front of them.
  const waiting = await proposed();
  expect(await importLibraryDocument(form({ kind: "paste", content: DOCUMENT })))
    .toMatchObject({ ok: true, message: expect.stringContaining("What was found in it is below") });
  expect(await tasks()).toHaveLength(0);

  // Accepted or dismissed, the card is gone — so "below" would be a lie. Handing the same
  // document over again is a deliberate act, and the text is still here to read.
  await dismissLibraryImport(waiting.id);
  expect(await importLibraryDocument(form({ kind: "paste", content: DOCUMENT })))
    .toMatchObject({ ok: true, message: expect.stringContaining("reading it again") });
  expect(await getLibraryImport(database, user.id, waiting.id))
    .toMatchObject({ processedAt: null, proposal: null, error: null, resolvedAt: null, content: DOCUMENT });
  expect((await tasks()).map(task => task.type)).toEqual(["import_library_document"]);
  expect(await imports()).toHaveLength(1);

  // A file nothing could be read from keeps its refusal: the same upload would fail the same way.
  const lost = await createLibraryImport(database, { userId: user.id, kind: "cv", filename: "scan.pdf", sourceBytes: Buffer.from("%PDF-scan") });
  await database.update(schema.libraryImports)
    .set({ error: "There is no readable text in that PDF.", processedAt: new Date(), sourceBytes: null })
    .where(eq(schema.libraryImports.id, lost.id));
  expect(await importLibraryDocument(form({ kind: "cv", file: new File([Buffer.from("%PDF-scan")], "scan.pdf", { type: "application/pdf" }) })))
    .toMatchObject({ ok: false, error: "There is no readable text in that PDF." });
});

it("takes an uploaded PDF as bytes and refuses anything that is not a document", async () => {
  const pdf = await renderCvPdf({
    name: "Jane Okafor", contact: "London", summary: "Operations leader",
    sections: [{ entryId: "e1", kind: "experience", heading: "Director of Operations · Acme", bullets: [ROWS.handover] }],
    gaps: [],
  });
  const file = new File([new Uint8Array(pdf)], "jane-okafor-cv.pdf", { type: "application/pdf" });

  expect(await importLibraryDocument(form({ kind: "cv", file }))).toMatchObject({ ok: true });
  const [row] = await imports();
  expect(row).toMatchObject({ kind: "cv", filename: "jane-okafor-cv.pdf", sourceMime: "application/pdf", content: null });
  expect(row!.sourceBytes!.length).toBe(pdf.length);

  // A photograph called a CV, and a file over the cap: both refused, and neither stored.
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "scan.png", { type: "application/pdf" });
  expect(await importLibraryDocument(form({ kind: "cv", file: png })))
    .toMatchObject({ ok: false, error: expect.stringContaining("PDF and Word") });
  const huge = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });
  expect(await importLibraryDocument(form({ kind: "cv", file: huge })))
    .toMatchObject({ ok: false, error: expect.stringContaining("larger than 5 MB") });
  expect(await imports()).toHaveLength(1);
});

it("takes the person's own page and never LinkedIn", async () => {
  expect(await importLibraryDocument(form({ kind: "website", url: "https://www.linkedin.com/in/jane-okafor" })))
    .toMatchObject({ ok: false, error: expect.stringContaining("Save to PDF") });
  expect(await importLibraryDocument(form({ kind: "website", url: "http://jane.example/about" })))
    .toMatchObject({ ok: false, error: expect.stringContaining("https://") });
  expect(await importLibraryDocument(form({ kind: "website", url: "not a url" })))
    .toMatchObject({ ok: false });
  expect(await imports()).toHaveLength(0);

  expect(await importLibraryDocument(form({ kind: "website", url: "https://jane.example/about" }))).toMatchObject({ ok: true });
  expect((await imports())[0]).toMatchObject({ kind: "website", url: "https://jane.example/about" });
});

it("asks an unverified account to confirm its email before reading anything", async () => {
  auth.requireVerifiedUser.mockImplementation(async () => { throw new Error("NEXT_REDIRECT"); });

  await expect(importLibraryDocument(form({ kind: "paste", content: DOCUMENT }))).rejects.toThrow("NEXT_REDIRECT");
  expect(await imports()).toHaveLength(0);
});

it("adds the ticked items with their rows unconfirmed, through the Library's own save", async () => {
  const row = await proposed();

  const result = await acceptLibraryImport(row.id, form({
    version: "0",
    accept: ["job-0", "job-0-row-0", "job-0-row-1", "education-0"],
  }));

  expect(result).toMatchObject({ ok: true, message: expect.stringContaining("They arrive with their rows unconfirmed") });
  expect((result as { message: string }).message).toContain("Added 1 job, 2 responsibilities and 1 qualification");
  const saved = await latestLibrary();
  expect(saved!.version).toBe(1);
  const library = saved!.content;
  expect(library.employment).toMatchObject([{ company: "Acme Logistics", jobTitle: "Director of Operations", startDate: "2020-03", endDate: "2022-06" }]);
  const experience = library.entries.find(entry => entry.kind === "experience")!;
  expect(experience.status).toBe("active");
  expect(experience.confirmedResponsibilities ?? []).toEqual([]);
  expect(responsibilityRows(experience.details)).toEqual([ROWS.moved, ROWS.handover]);
  expect(library.entries.find(entry => entry.kind === "education")).toMatchObject({ status: "active", heading: "University of Leeds" });

  // The import is finished with, and the save queued what any other save queues.
  expect((await getLibraryImport(database, user.id, row.id))!.resolvedAt).toBeInstanceOf(Date);
  expect((await tasks()).map(task => task.type).sort()).toEqual(["rescore_all", "review_library"]);
});

it("adds only what was ticked, and refuses a form that ticked nothing", async () => {
  const row = await proposed();

  expect(await acceptLibraryImport(row.id, form({ version: "0", accept: [] })))
    .toMatchObject({ ok: false, error: expect.stringContaining("Tick at least one item") });
  expect(await latestLibrary()).toBeUndefined();

  await acceptLibraryImport(row.id, form({ version: "0", accept: ["job-0", "job-0-row-1"] }));

  const library = (await latestLibrary())!.content;
  expect(responsibilityRows(library.entries.find(entry => entry.kind === "experience")!.details)).toEqual([ROWS.handover]);
  expect(library.entries.some(entry => entry.kind === "education")).toBe(false);
});

it("anchors the proposal against the document again before writing any of it", async () => {
  // A row nobody wrote, on an import whose stored document does not carry it.
  const row = await proposed({
    proposal: {
      ...PROPOSAL,
      employment: [{ ...PROPOSAL.employment[0], responsibilities: [
        { id: "job-0-row-0", text: "Saved £2.4m a year across the network", quote: "Saved £2.4m a year across the network" },
      ] }],
    },
  });

  // Items are named by their place in the proposal, so one that no longer anchors would move the
  // ids after it onto other items: nothing is added from a proposal that does not check out whole.
  const result = await acceptLibraryImport(row.id, form({ version: "0", accept: ["job-0", "job-0-row-0", "education-0"] }));

  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Dismiss it and import the document again") });
  expect(await latestLibrary()).toBeUndefined();
  expect((await imports())[0]!.resolvedAt).toBeNull();
});

it("adds the ticked items of a proposal that checks out whole", async () => {
  const row = await proposed();
  // The job alone would leave a library with no blocks at all, which is not a Library.
  expect(await acceptLibraryImport(row.id, form({ version: "0", accept: ["job-0"] })))
    .toMatchObject({ ok: false, error: expect.stringContaining("a job on its own cannot start your Library") });
  expect(await acceptLibraryImport(row.id, form({ version: "0", accept: ["job-0", "job-0-row-1", "education-0"] }))).toMatchObject({ ok: true });
  const library = (await latestLibrary())!.content;
  expect(library.employment).toHaveLength(1);
  expect(library.entries.find(entry => entry.kind === "experience")!.details).toBe(ROWS.handover);
});

it("stores a pasted document without the control characters a database refuses", async () => {
  const pasted = `${DOCUMENT}\u0000\u0007 and a line more to read`;
  expect(await importLibraryDocument(form({ kind: "paste", content: pasted }))).toMatchObject({ ok: true });
  expect((await imports())[0]!.content).toBe(`${DOCUMENT} and a line more to read`);
});

it("refuses to write over a library that changed while the card was open", async () => {
  const row = await proposed();
  await saveLibrary({ name: "Jane Okafor", contact: "", profile: "", structuredExperience: true, employment: [],
    entries: [{ id: "one", kind: "skill", status: "active", heading: "Skills", details: "Kanban", skillItems: ["Kanban"] }] });

  expect(await acceptLibraryImport(row.id, form({ version: "0", accept: ["job-0"] })))
    .toMatchObject({ ok: false, error: expect.stringContaining("The library changed") });
  expect((await latestLibrary())!.version).toBe(1);
  expect((await getLibraryImport(database, user.id, row.id))!.resolvedAt).toBeNull();
});

it("adds to a library that already has the job rather than repeating it", async () => {
  const row = await proposed();
  await saveLibrary({
    name: "Jane Okafor", contact: "", profile: "", structuredExperience: true,
    employment: [{ id: "job1", company: "Acme Logistics", jobTitle: "Director of Operations", startDate: "2020-03", endDate: "2022-06", current: false }],
    entries: [{ id: "existing", kind: "experience", status: "active", heading: "Director of Operations · Acme Logistics",
      employmentId: "job1", details: ROWS.handover, confirmedResponsibilities: [ROWS.handover] }],
  });

  await acceptLibraryImport(row.id, form({ version: "1", accept: ["job-0", "job-0-row-0", "job-0-row-1"] }));

  const library = (await latestLibrary())!.content;
  expect(library.employment).toHaveLength(1);
  const experience = library.entries.filter(entry => entry.kind === "experience");
  expect(experience).toHaveLength(1);
  // The confirmed row keeps its confirmation; the new one arrives beside it, unconfirmed.
  expect(experience[0]).toMatchObject({ status: "active", confirmedResponsibilities: [ROWS.handover] });
  expect(responsibilityRows(experience[0]!.details)).toEqual([ROWS.handover, ROWS.moved]);
});

it("asks for a name before writing the first library of an account that has none", async () => {
  const row = await proposed();
  auth.requireUser.mockImplementation(async () => ({ ...user, name: null }));

  expect(await acceptLibraryImport(row.id, form({ version: "0", accept: ["job-0"] })))
    .toMatchObject({ ok: false, error: expect.stringContaining("Add your name") });
  expect(await latestLibrary()).toBeUndefined();
});

it("will not touch another account's import, whichever way it is asked", async () => {
  const row = await proposed();
  auth.requireUser.mockImplementation(async () => other);

  expect(await acceptLibraryImport(row.id, form({ version: "0", accept: ["job-0"] }))).toMatchObject({ ok: false });
  expect(await dismissLibraryImport(row.id)).toMatchObject({ ok: false });
  expect(await retryLibraryImport(row.id)).toMatchObject({ ok: false });
  expect((await getLibraryImport(database, user.id, row.id))!.resolvedAt).toBeNull();
  expect(await database.select().from(schema.cvLibraries)).toHaveLength(0);
});

it("dismisses an import without adding anything, and only once", async () => {
  const row = await proposed();

  expect(await dismissLibraryImport(row.id)).toMatchObject({ ok: true, message: expect.stringContaining("Nothing was added") });
  expect((await getLibraryImport(database, user.id, row.id))!.resolvedAt).toBeInstanceOf(Date);
  expect(await database.select().from(schema.cvLibraries)).toHaveLength(0);
  // A second submit is not a second dismissal.
  expect(await dismissLibraryImport(row.id)).toMatchObject({ ok: false });
});

it("reads a refused document again only while the text is still here", async () => {
  const row = await createLibraryImport(database, { userId: user.id, kind: "paste", content: DOCUMENT });
  await database.update(schema.libraryImports)
    .set({ error: "Library document import needs about $0.09; your budget has $0.00 left this month.", processedAt: new Date() })
    .where(eq(schema.libraryImports.id, row.id));

  expect(await retryLibraryImport(row.id)).toMatchObject({ ok: true, message: expect.stringContaining("reading your document again") });
  const reopened = await getLibraryImport(database, user.id, row.id);
  expect(reopened).toMatchObject({ error: null, proposal: null, processedAt: null, content: DOCUMENT });
  expect((await tasks()).map(task => task.type)).toEqual(["import_library_document"]);

  // A file that could never be converted has nothing left to read.
  const lost = await createLibraryImport(database, { userId: user.id, kind: "cv", filename: "scan.pdf", sourceBytes: Buffer.from("%PDF-nope") });
  await database.update(schema.libraryImports).set({ error: "There is no readable text in that PDF.", processedAt: new Date(), sourceBytes: null })
    .where(eq(schema.libraryImports.id, lost.id));
  expect(await retryLibraryImport(lost.id)).toMatchObject({ ok: false, error: expect.stringContaining("no longer holds that document") });
});
