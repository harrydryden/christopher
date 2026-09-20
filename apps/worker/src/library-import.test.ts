/**
 * The `import_library_document` task, end to end against the database.
 *
 * It drives the real A11 engine through a scripted client, because what matters is not what a
 * model would say but what is done with what it says: the document reaches the call as data, what
 * the document does not support is dropped before anything is stored, the upload's bytes are gone
 * the moment the conversion is recorded, and everything the person can act on — a file that is a
 * photograph, a site that refuses us, a month that is spent — finishes the task with a sentence on
 * the row rather than failing it and retrying for ever.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createDb, createLibraryImport, getLibraryImport, listOpenLibraryImports, schema, type Db,
} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import type { AiClientLike, ParseResponse } from "@christopher/ai";
import { renderCvPdf } from "@christopher/core/cv-pdf";
import type { LibraryProposal } from "@christopher/core";
import { sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handlers } from "./handlers";
import { handleImportLibraryDocument } from "./handlers/library-import";
import { ensureTestUser } from "./test-users";
import { startTestServer, type TestServer } from "./test-server";

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test";
const HOSTS = ["jane.example.test", "www.jane.example.test", "closed.example.test"];

const ROWS = {
  moved: "Ran the UK warehouse team of 30 through a move to a new site",
  handover: "Cut handover time from two days to four hours",
  stockouts: "Reduced stockouts by 18% in one quarter",
};
const DOCUMENT = [
  "Jane Okafor — Operations leader",
  "",
  "Director of Operations, Acme Logistics, Mar 2020 – Jun 2022",
  `• ${ROWS.moved}`,
  `• ${ROWS.handover}`,
  "",
  "Head of Delivery, Northwind, 2017 – 2020",
  `• ${ROWS.stockouts}`,
  "",
  "MSc Operations Management, University of Leeds, 2014",
].join("\n");

/**
 * Two jobs, read correctly, plus one responsibility the document never carried — which is the
 * case the post-check exists for.
 */
const ANSWER = {
  employment: [
    {
      company: "Acme Logistics", title: "Director of Operations", startDate: "2020-03", endDate: "2022-06", current: false,
      quote: "Director of Operations, Acme Logistics, Mar 2020 – Jun 2022",
      responsibilities: [
        { text: ROWS.moved, quote: "move to a new site" },
        { text: ROWS.handover, quote: ROWS.handover },
        { text: "Saved £2.4m a year across the network", quote: "Saved £2.4m a year across the network" },
      ],
    },
    {
      company: "Northwind", title: "Head of Delivery", startDate: "2017", endDate: "2020", current: false,
      quote: "Head of Delivery, Northwind, 2017 – 2020",
      responsibilities: [{ text: ROWS.stockouts, quote: ROWS.stockouts }],
    },
  ],
  education: [{ heading: "University of Leeds", detail: "MSc Operations Management, University of Leeds, 2014", quote: "MSc Operations Management" }],
  skills: [],
};

const USAGE = { input_tokens: 4200, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** A client that records the document it was sent and answers with whatever the test scripted. */
function scriptedClient(answer: unknown = ANSWER) {
  const documents: string[] = [];
  const client: AiClientLike = {
    messages: {
      async create(params): Promise<ParseResponse> {
        const content = (params.messages as Array<{ content: string }>)[0]!.content;
        documents.push(content);
        return { parsed_output: answer, usage: USAGE, stop_reason: "end_turn", model: "claude-fable-5-1" };
      },
    },
  };
  return { client, documents };
}

const task = (payload: Record<string, unknown>) =>
  ({ id: "00000000-0000-0000-0000-000000000000", type: "import_library_document", payload, attempts: 1 } as never);

let server: TestServer;
let deps: WorkerDeps;
let db: Db;
let userId: string;
let otherId: string;
const now = new Date("2026-09-19T09:00:00Z");

const PAGE = `<!doctype html><html><head><title>Jane Okafor</title><style>body{color:red}</style></head>
  <body><h1>Jane Okafor — Operations leader</h1>
  <p>Director of Operations, Acme Logistics, Mar 2020 – Jun 2022</p>
  <ul><li>${ROWS.moved}</li><li>${ROWS.handover}</li></ul>
  <p>Head of Delivery, Northwind, 2017 – 2020</p><ul><li>${ROWS.stockouts}</li></ul>
  <p>MSc Operations Management, University of Leeds, 2014</p></body></html>`;

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  server = await startTestServer({
    "jane.example.test": {
      "/robots.txt": { body: "User-agent: *\nAllow: /\n", contentType: "text/plain" },
      "/about": { body: PAGE },
      "/gone": { status: 404, body: "<html><body>Not found</body></html>" },
    },
    "closed.example.test": {
      "/robots.txt": { body: "User-agent: *\nDisallow: /\n", contentType: "text/plain" },
      "/cv": { body: PAGE },
    },
  }, HOSTS);
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.CHRISTOPHER_HOST_MAP = JSON.stringify(server.hostMap);
  process.env.CHRISTOPHER_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv(), { now: () => now, settingsTtlMs: 0 });
  db = deps.db;
  userId = (await ensureTestUser(db, "library-import-task@example.com")).id;
  otherId = (await ensureTestUser(db, "library-import-other@example.com", "member")).id;
}, 60_000);

afterAll(async () => {
  await deps?.close();
  await server?.close();
});

beforeEach(async () => {
  await db.execute(sql`truncate library_imports, tasks, ai_calls, ai_reservations, user_settings, host_pacing restart identity cascade`);
  deps.aiClient = undefined;
  deps.invalidateSettings();
});

const proposalOf = async (id: string) => (await getLibraryImport(db, userId, id))?.proposal as LibraryProposal | null;

it("is the handler the queue runs for this task type", () => {
  expect(handlers.import_library_document).toBe(handleImportLibraryDocument);
});

it("reads a pasted CV into a proposal and drops the row the document never carried", async () => {
  const row = await createLibraryImport(db, { userId, kind: "paste", content: DOCUMENT }, now);
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;

  const result = await handleImportLibraryDocument(task({ userId, importId: row.id }), deps);

  expect(result).toMatchObject({ proposed: { jobs: 2, rows: 3, education: 1, skills: 0 }, dropped: 1, truncated: false });
  // The document went to the model as data, in its own block, and nowhere else.
  expect(scripted.documents).toHaveLength(1);
  expect(scripted.documents[0]).toBe(`<document>\n${DOCUMENT}\n</document>`);

  const proposal = await proposalOf(row.id);
  expect(proposal!.employment.map(job => [job.company, job.title, job.startDate, job.endDate]))
    .toEqual([["Acme Logistics", "Director of Operations", "2020-03", "2022-06"], ["Northwind", "Head of Delivery", "2017", "2020"]]);
  expect(proposal!.employment[0]!.responsibilities.map(item => item.text)).toEqual([ROWS.moved, ROWS.handover]);
  expect(proposal!.education.map(item => item.heading)).toEqual(["University of Leeds"]);

  const stored = await getLibraryImport(db, userId, row.id);
  expect(stored).toMatchObject({ error: null, content: DOCUMENT });
  expect(stored!.processedAt).toBeInstanceOf(Date);
  // Still open: the person has neither accepted nor dismissed it.
  expect((await listOpenLibraryImports(db, userId)).map(item => item.id)).toEqual([row.id]);

  // Recorded against the account, under its own call site, naming the import it was for.
  const calls = await db.select().from(schema.aiCalls);
  expect(calls.map(call => [call.callSite, call.userId, call.refType, call.refId])).toEqual([["A11", userId, "library_import", row.id]]);
  expect(await db.select().from(schema.aiReservations)).toHaveLength(0);
});

it("converts an uploaded PDF, keeps the text and leaves nothing binary behind", async () => {
  const pdf = await renderCvPdf({
    name: "Jane Okafor", contact: "London", summary: "Operations leader",
    sections: [{ entryId: "e1", kind: "experience", heading: "Director of Operations · Acme Logistics", bullets: [ROWS.moved, ROWS.handover] }],
    gaps: [],
  });
  const row = await createLibraryImport(db, {
    userId, kind: "cv", filename: "jane-okafor-cv.pdf", sourceBytes: pdf, sourceMime: "application/pdf",
  }, now);
  // The PDF's own heading, which is not how the pasted CV above wrote it, and no dates: the
  // rendered document carries neither year, so neither may be proposed.
  const scripted = scriptedClient({
    employment: [{
      ...ANSWER.employment[0], startDate: "2020-03", endDate: "2022-06",
      quote: "Director of Operations \u00b7 Acme Logistics",
      responsibilities: [{ text: ROWS.moved, quote: ROWS.moved }, { text: ROWS.handover, quote: ROWS.handover }],
    }],
    education: [], skills: [],
  });
  deps.aiClient = scripted.client;

  const result = await handleImportLibraryDocument(task({ userId, importId: row.id }), deps);

  expect(result).toMatchObject({ proposed: { jobs: 1, rows: 2 } });
  expect(scripted.documents[0]).toContain(ROWS.handover);
  // A date the PDF does not carry is left for the person to fill in.
  expect((await proposalOf(row.id))!.employment[0]).toMatchObject({ startDate: "", endDate: "" });
  const stored = await getLibraryImport(db, userId, row.id);
  expect(stored!.content).toContain(ROWS.moved);
  // The bytes are gone, and with them the only copy of the file the product ever held.
  const [raw] = await db.select().from(schema.libraryImports);
  expect(raw!.sourceBytes).toBeNull();
  expect(raw!.sourceMime).toBeNull();
});

it("fetches the person's own page politely and reads the text out of it", async () => {
  const row = await createLibraryImport(db, { userId, kind: "website", url: "https://jane.example.test/about" }, now);
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;

  const result = await handleImportLibraryDocument(task({ userId, importId: row.id }), deps);

  expect(result).toMatchObject({ proposed: { jobs: 2, rows: 3, education: 1 } });
  // robots.txt was read before the page was, as it is for any other site.
  expect(server.requests.map(request => request.url)).toContain("/robots.txt");
  // Text, not markup: the stylesheet and the tags are gone.
  const stored = await getLibraryImport(db, userId, row.id);
  expect(stored!.content).toContain(ROWS.stockouts);
  expect(stored!.content).not.toContain("<li>");
  expect(stored!.content).not.toContain("color:red");
});

it("says so rather than crawling on when a site asks not to be fetched", async () => {
  const row = await createLibraryImport(db, { userId, kind: "website", url: "https://closed.example.test/cv" }, now);
  deps.aiClient = scriptedClient().client;

  const result = await handleImportLibraryDocument(task({ userId, importId: row.id }), deps) as { message: string };

  expect(result.message).toContain("asks not to be fetched automatically");
  expect((await getLibraryImport(db, userId, row.id))!.error).toContain("Paste the text of the page instead.");
  expect(await db.select().from(schema.aiCalls)).toHaveLength(0);
});

it("never fetches LinkedIn, however the row got there, and says what to do instead", async () => {
  const row = await createLibraryImport(db, { userId, kind: "website", url: "https://www.linkedin.com/in/jane-okafor" }, now);
  deps.aiClient = scriptedClient().client;

  const result = await handleImportLibraryDocument(task({ userId, importId: row.id }), deps) as { message: string };

  expect(result.message).toContain("Save to PDF");
  expect(server.requests.some(request => request.host.includes("linkedin"))).toBe(false);
  expect((await getLibraryImport(db, userId, row.id))!.processedAt).toBeInstanceOf(Date);
});

it("records the page that is not there, and retries the server that is having a bad minute", async () => {
  const gone = await createLibraryImport(db, { userId, kind: "website", url: "https://jane.example.test/gone" }, now);
  deps.aiClient = scriptedClient().client;

  expect(await handleImportLibraryDocument(task({ userId, importId: gone.id }), deps))
    .toMatchObject({ message: expect.stringContaining("answered HTTP 404") });

  // A page nobody is serving at all is a transport failure: worth the queue's backoff.
  const unreachable = await createLibraryImport(db, { userId, kind: "website", url: "https://unmapped.example.test/cv" }, now);
  await expect(handleImportLibraryDocument(task({ userId, importId: unreachable.id }), deps)).rejects.toThrow(/Could not fetch/);
  expect((await getLibraryImport(db, userId, unreachable.id))!.processedAt).toBeNull();
});

it("finishes done with the budget sentence when the account cannot afford to read the document", async () => {
  const row = await createLibraryImport(db, { userId, kind: "paste", content: DOCUMENT }, now);
  await db.insert(schema.userSettings).values({ userId, key: "aiBudgetUsd", value: 0.0001 });
  deps.invalidateSettings();
  const scripted = scriptedClient();
  deps.aiClient = scripted.client;

  const result = await handleImportLibraryDocument(task({ userId, importId: row.id }), deps) as { skipped: string; message: string };

  expect(result.skipped).toBe("budget");
  expect(result.message).toContain("Library document import needs about $");
  expect(result.message).toContain("Raise it on Settings");
  // Nothing was asked of the model, and nothing is left holding capacity.
  expect(scripted.documents).toHaveLength(0);
  expect(await db.select().from(schema.aiCalls)).toHaveLength(0);
  expect(await db.select().from(schema.aiReservations)).toHaveLength(0);
  // The refusal is on the row, with the document kept: raising the budget reads this one again.
  const stored = await getLibraryImport(db, userId, row.id);
  expect(stored!.error).toBe(result.message);
  expect(stored!.content).toBe(DOCUMENT);
  expect(stored!.proposal).toBeNull();
});

it("records a file it cannot read as a sentence, not as a failure to retry", async () => {
  const row = await createLibraryImport(db, {
    userId, kind: "cv", filename: "scan.png", sourceBytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400)]),
    sourceMime: "image/png",
  }, now);
  deps.aiClient = scriptedClient().client;

  const result = await handleImportLibraryDocument(task({ userId, importId: row.id }), deps) as { message: string };

  expect(result.message).toContain("PDF and Word");
  const [raw] = await db.select().from(schema.libraryImports);
  expect(raw!.sourceBytes).toBeNull();
  expect(raw!.error).toContain("PDF and Word");
  expect(await db.select().from(schema.aiCalls)).toHaveLength(0);
});

it("says nothing could be matched when the answer is about a different career", async () => {
  const row = await createLibraryImport(db, { userId, kind: "paste", content: DOCUMENT }, now);
  deps.aiClient = scriptedClient({
    employment: [{ company: "Globex", title: "Chief Operating Officer", quote: "Chief Operating Officer, Globex", responsibilities: [] }],
    education: [], skills: [],
  }).client;

  const result = await handleImportLibraryDocument(task({ userId, importId: row.id }), deps) as { message: string };

  expect(result.message).toContain("Nothing in that document could be matched");
  expect((await getLibraryImport(db, userId, row.id))!.proposal).toBeNull();
  // The call was made and is billed for; the answer was refused afterwards.
  expect(await db.select().from(schema.aiCalls)).toHaveLength(1);
});

it("still keeps the document for an account whose deployment has no model configured", async () => {
  const row = await createLibraryImport(db, { userId, kind: "paste", content: DOCUMENT }, now);
  const key = deps.env.anthropicApiKey;
  deps.env.anthropicApiKey = undefined;
  try {
    expect(await handleImportLibraryDocument(task({ userId, importId: row.id }), deps))
      .toMatchObject({ message: expect.stringContaining("no model is configured") });
  } finally {
    deps.env.anthropicApiKey = key;
  }
  expect((await getLibraryImport(db, userId, row.id))!.content).toBe(DOCUMENT);
});

it("does nothing for an import that is gone, or one that belongs to somebody else", async () => {
  const mine = await createLibraryImport(db, { userId, kind: "paste", content: DOCUMENT }, now);
  deps.aiClient = scriptedClient().client;

  expect(await handleImportLibraryDocument(task({ userId, importId: "00000000-0000-4000-8000-000000000000" }), deps))
    .toEqual({ skipped: "import no longer exists" });
  expect(await handleImportLibraryDocument(task({ userId: otherId, importId: mine.id }), deps))
    .toEqual({ skipped: "import belongs to another account" });
  expect((await getLibraryImport(db, userId, mine.id))!.processedAt).toBeNull();
});
