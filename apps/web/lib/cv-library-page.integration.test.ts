/**
 * The Library page's reads, against the database: the evidence it shows, the poll token it hands
 * its poller, and the saved versions a diff compares.
 *
 * The save, the review row and the queue row are all real here, because the three things that can
 * go wrong are wiring rather than arithmetic: a review stored against wording that has since been
 * edited must not be shown, a signature that does not move when a review lands leaves a page
 * saying "Evaluating…" for good, and a diff of a version another account saved must not be
 * readable at all.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, upsertLibraryReviews, type Db } from "@col/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@col/db/migrate";
import { and, desc, eq, sql } from "drizzle-orm";
import { libraryEntryInputHash, rulesLibraryReview } from "@col/core/library-review";
import { EVIDENCE_MARKS_BY_FACET, detectEvidenceMarks, scoreRowAgainst } from "@col/core/evidence-rubric";
import { sha1 } from "@col/core";
import type { CvLibrary, EvidenceFacet } from "@col/core/cv";
import { signInTestUser } from "@/test/auth";
import type { User } from "@col/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { rescoreLibrary, saveCvLibrary } from "@/app/actions/cv";
import { getCareerWorkspace, saveCareerChange, undoCareerChange } from "@/app/actions/career";
import { GET as reviewsRoute } from "@/app/api/cv/library/reviews/route";
import {
  getLibraryEvidence,
  getOwnCvLibrary,
  libraryReviewSignature,
  ownsLibraryVersion,
} from "./queries/cv";

const ACME = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };

function libraryFixture(rows: string[], facets: Record<string, EvidenceFacet[]> = {}): CvLibrary {
  return {
    name: "Test Candidate",
    contact: "London",
    profile: "Operations leader",
    structuredExperience: true,
    employment: [ACME],
    entries: [{
      id: "acme-block",
      kind: "experience",
      status: "active",
      employmentId: "acme",
      heading: "Operations Director · Acme",
      details: rows.join("\n"),
      confirmedResponsibilities: rows,
      ...(Object.keys(facets).length ? { rowFacets: facets } : {}),
    }],
  };
}

async function save(library: CvLibrary, version: number) {
  const form = new FormData();
  form.set("library", JSON.stringify(library));
  form.set("version", String(version));
  return saveCvLibrary({ ok: true }, form);
}

/** The reviews route, as the poller calls it. */
async function signatureOf(version: number | string) {
  const response = await reviewsRoute(new Request(`https://example.test/api/cv/library/reviews?version=${version}`));
  return { status: response.status, body: await response.json() as { signature?: string; error?: string } };
}

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "library-page-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate cv_library_reviews, cv_libraries, cv_drafts, tasks, settings, user_settings, users restart identity cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});

it("shows the badge, the prompts and the poll token a saved Library's reviews produce", async () => {
  expect(await save(libraryFixture(["Led a team of nine through a move to one site", "Cut handovers by 40%"], {
    "Led a team of nine through a move to one site": ["responsibility"],
    "Cut handovers by 40%": ["metric"],
  }), 0)).toEqual({ ok: true });

  const stored = (await getOwnCvLibrary(user.id))!;
  expect(stored.version).toBe(1);

  // The save queued nothing: its rows are scored here from the person's own tags, provisionally,
  // and nothing is evaluating — which is what puts the Re-score button on the page.
  const saved = await getLibraryEvidence(user.id, stored);
  expect(saved.entries[0]).toMatchObject({ source: "rules", provisional: true, evaluating: false });
  expect(saved.evaluating).toBe(false);

  // Re-scoring queues the pass, so every entry reads as evaluating against the baseline computed
  // here rather than as scored.
  expect(await rescoreLibrary({ ok: true }, new FormData())).toEqual({ ok: true });
  const queued = await getLibraryEvidence(user.id, stored);
  const baseline = rulesLibraryReview(stored.content.entries[0]!, stored.content);
  expect(queued.entries).toHaveLength(1);
  expect(queued.entries[0]).toMatchObject({
    entryId: stored.content.entries[0]!.id,
    employmentId: stored.content.entries[0]!.employmentId,
    source: "rules",
    provisional: true,
    evaluating: true,
    score: baseline.score,
    rating: baseline.rating,
  });
  expect(queued.evaluating).toBe(true);
  // The career bridge preserves the original wording without inventing the former editor's
  // facet selections; until a review lands its provisional rubric has no tagged types.
  expect(baseline.score).toBe(0);
  expect(baseline.rating).toBe("none");
  expect(queued.line).toMatch(/^Evidence:/);
  // Nothing is stored yet, so the poll token is empty and the route says so.
  const before = await signatureOf(stored.version);
  expect(before.status).toBe(200);
  expect(before.body.signature).toBe("0:");

  // The model's review of this exact wording lands.
  const entry = stored.content.entries[0]!;
  const inputHash = libraryEntryInputHash(entry, ACME);
  await upsertLibraryReviews(database, user.id, stored.version, [{
    entryId: entry.id,
    inputHash,
    source: "model",
    model: "test-model",
    review: {
      ...baseline,
      // The model reads the second row as both the outcome and the figure that moved, which is
      // what a row carrying two types is for. Responsibility 1 + outcome 2 + metric 2 of 8 is
      // 31.25. The rows are scored against the person's tags: the responsibility row earns two
      // marks of four, the metric row all four, a mean of 75 and 37.5 more: 69, which is Good.
      // Projection order follows stable career identities/relevance, not the old pasted order.
      // Attach this fake review to the statement it actually reviewed.
      rows: baseline.rows.map(row => row.row === "Led a team of nine through a move to one site"
        ? { ...row, facets: ["responsibility"], marks: ["responsibility.scope", "responsibility.ownership"] }
        : { ...row, facets: ["outcome", "metric"], marks: ["outcome.change", ...EVIDENCE_MARKS_BY_FACET.metric] }),
      prompts: ["What did the move to one site achieve?", "What changed as a result?"],
      score: 69,
      rating: "good",
    },
  }]);

  const after = await signatureOf(stored.version);
  expect(after.body.signature).not.toBe(before.body.signature);

  const scored = await getLibraryEvidence(user.id, stored);
  expect(scored.entries[0]).toMatchObject({ source: "model", provisional: false, evaluating: false, score: 60, rating: "good" });
  expect(scored.evaluating).toBe(false);
  expect(scored.line).toBe("Evidence: Good");
  // Each row carries what its score is read from, not the number: the person's tags, the marks the
  // review found and what the review read the row as, so the editor scores it against the tags
  // on screen.
  expect(scored.entries[0]!.rows.map(row => row.row)).toEqual(baseline.rows.map(row => row.row));
  expect([...scored.entries[0]!.rows].sort((a, b) => a.row.localeCompare(b.row))).toEqual([
    { row: "Cut handovers by 40%", tagged: [], marks: ["outcome.change", ...EVIDENCE_MARKS_BY_FACET.metric], reviewFacets: ["outcome", "metric"], verified: true },
    { row: "Led a team of nine through a move to one site", tagged: [], marks: ["responsibility.scope", "responsibility.ownership"], reviewFacets: ["responsibility"], verified: true },
  ]);
  expect(scored.entries[0]!.rows.map(row => scoreRowAgainst(row.marks, row.tagged).score)).toEqual([null, null]);
  // Each prompt is one question; the one that is a type's own question carries that type for the
  // "Add a row for this" control, and the one the model wrote itself does not.
  expect(scored.entries[0]!.prompts).toEqual([
    { question: "What did the move to one site achieve?", facet: null },
    { question: "What changed as a result?", facet: "outcome" },
  ]);
});

it("reads a review in an earlier release's shape, in today's shape", async () => {
  // Reviews written before a row could carry several types name one `facet`, as a string, and
  // reviews written before the type-specific rubric carry no marks. The rubric version in the hash
  // keeps those from matching today's wording, but a row in either shape is still read through the
  // one normaliser: read as written, its rows would carry no types and no marks at all.
  await save(libraryFixture(["Led a team of nine through a move to one site", "Cut handovers by 40%"], {
    "Led a team of nine through a move to one site": ["responsibility"],
    "Cut handovers by 40%": ["metric"],
  }), 0);
  const stored = (await getOwnCvLibrary(user.id))!;
  const entry = stored.content.entries[0]!;
  const rows = ["Led a team of nine through a move to one site", "Cut handovers by 40%"];
  await upsertLibraryReviews(database, user.id, stored.version, [{
    entryId: entry.id,
    inputHash: libraryEntryInputHash(entry, ACME),
    source: "model",
    model: "test-model",
    review: {
      entryId: entry.id,
      rows: [
        { row: rows[0]!, facet: "responsibility", specific: true, quantified: false, outcomeLinked: false, quote: rows[0]!, verified: true },
        { row: rows[1]!, facet: "unclear", specific: false, quantified: true, outcomeLinked: false, quote: rows[1]!, verified: true },
      ],
      prompts: ["What changed as a result?"],
      // What that release stored alongside the rows. The score is recomputed from the rows on the
      // way out, so a review read back is consistent with what it is about.
      coverage: {},
      missing: [],
      score: 0,
      rating: "none",
    } as never,
  }]);

  const evidence = await getLibraryEvidence(user.id, stored);
  const view = evidence.entries[0]!;
  expect(view.source).toBe("model");
  // One row classified as a responsibility and one the release could not classify: the first is
  // covered, the second covers nothing, and the sentence says what is still missing.
  expect(view.missing).toEqual(["outcome", "metric", "problem", "milestone", "style"]);
  expect(view.missingLine).toBe("No outcomes or metrics moved yet · 3 other types untagged");
  expect(view.score).toBeGreaterThan(0);
  expect(view.prompts).toEqual([{ question: "What changed as a result?", facet: "outcome" }]);
  expect(view.reviewedRows).toEqual(rows);
  // With no marks stored, wording rules stand in. The career projection retains the original
  // statement, but legacy row tags are not invented as direct career assertions.
  expect(view.rows.map(row => row.marks)).toEqual(rows.map(detectEvidenceMarks));
  expect(view.rows.map(row => row.tagged)).toEqual([[], []]);
  expect(view.rows.map(row => row.reviewFacets)).toEqual([["responsibility"], []]);
});

it("offers Re-score once for a review stored under the previous rubric, and keeps that review", async () => {
  await save(libraryFixture(["Led a team of nine through a move to one site"], {
    "Led a team of nine through a move to one site": ["responsibility"],
  }), 0);
  const stored = (await getOwnCvLibrary(user.id))!;
  const entry = stored.content.entries[0]!;
  // The hash the first rubric's reviews were stored under: the same list, with no version first.
  const previous = sha1(JSON.stringify([["Led a team of nine through a move to one site"], ["responsibility"], ACME.company, ACME.jobTitle]));
  expect(previous).not.toBe(libraryEntryInputHash(entry, ACME));
  await upsertLibraryReviews(database, user.id, stored.version, [{
    entryId: entry.id, inputHash: previous, source: "model", model: "test-model",
    review: rulesLibraryReview(entry, stored.content),
  }]);

  // Not matched: the baseline stands in, provisionally, which is what puts Re-score on the page.
  const evidence = await getLibraryEvidence(user.id, stored);
  expect(evidence.entries[0]).toMatchObject({ source: "rules", provisional: true, evaluating: false });
  // And not deleted: it is simply no longer read.
  const kept = await database.select({ inputHash: schema.cvLibraryReviews.inputHash }).from(schema.cvLibraryReviews)
    .where(eq(schema.cvLibraryReviews.userId, user.id));
  expect(kept).toEqual([{ inputHash: previous }]);
});

it("archives work through the career record while keeping the earlier Library snapshot", async () => {
  await save(libraryFixture(["Led a team of nine through a move to one site"]), 0);
  const before = (await getOwnCvLibrary(user.id))!;
  const career = await getCareerWorkspace();
  const role = career.selected!.record;
  const fact = career.selected!.assertions.find(row => row.status === "usable")!;
  expect(role.kind).toBe("role");
  const archived = await saveCareerChange({ expectedRevision: career.revision, requestKey: crypto.randomUUID(),
    operations: [{ type: "archive_record", id: role.id, expectedRevision: role.revision, archived: true }] });
  expect(archived.ok).toBe(true);
  const after = (await getOwnCvLibrary(user.id))!;
  expect(after.version).toBeGreaterThan(before.version);
  expect((await getOwnCvLibrary(user.id))!.content.entries.some(entry => entry.id === role.id)).toBe(false);
  expect((await database.select().from(schema.careerAssertions).where(eq(schema.careerAssertions.id, fact.id)))[0]?.status).toBe("usable");
  expect((await database.select().from(schema.cvLibraries).where(and(eq(schema.cvLibraries.userId, user.id),
    eq(schema.cvLibraries.version, before.version))))[0]?.content).toEqual(before.content);
  expect((await getCareerWorkspace({ recordId: role.id })).selected?.record.archived).toBe(true);
});

it("undoes an archive without changing the role identity or its saved fact", async () => {
  await save(libraryFixture(["Led a team of nine through a move to one site"]), 0);
  const first = await getCareerWorkspace();
  const role = first.selected!.record;
  const factId = first.selected!.assertions.find(row => row.status === "usable")!.id;
  const archive = await saveCareerChange({ expectedRevision: first.revision, requestKey: crypto.randomUUID(),
    operations: [{ type: "archive_record", id: role.id, expectedRevision: role.revision, archived: true }] });
  if (!archive.ok) throw new Error(archive.error);
  const restored = await undoCareerChange({ changeId: archive.changeId, expectedRevision: archive.revision,
    requestKey: crypto.randomUUID() });
  expect(restored.ok).toBe(true);
  const current = await getCareerWorkspace({ recordId: role.id });
  expect(current.selected?.record).toMatchObject({ id: role.id, archived: false });
  expect(current.selected?.assertions.find(row => row.id === factId)).toMatchObject({
    text: "Led a team of nine through a move to one site", status: "usable" });
  expect((await getOwnCvLibrary(user.id))!.content.entries.some(entry => entry.id === role.id)).toBe(true);
});

it("treats a review of wording that has since been edited as no review at all", async () => {
  await save(libraryFixture(["Led a team of nine"]), 0);
  const first = (await getOwnCvLibrary(user.id))!;
  await upsertLibraryReviews(database, user.id, first.version, [{
    entryId: first.content.entries[0]!.id,
    inputHash: libraryEntryInputHash(first.content.entries[0]!, ACME),
    source: "model",
    model: "test-model",
    review: rulesLibraryReview(first.content.entries[0]!, first.content),
  }]);
  expect((await getLibraryEvidence(user.id, first)).entries[0]).toMatchObject({ source: "model", provisional: false });

  const career = await getCareerWorkspace();
  const fact = career.selected!.assertions.find(row => row.status === "usable")!;
  const changed = await saveCareerChange({ expectedRevision: career.revision, requestKey: crypto.randomUUID(),
    operations: [{ type: "edit_assertion", id: fact.id, expectedRevision: fact.revision,
      text: "Led a team of nine through a move to one site", publicText: null,
      facets: fact.facets, context: fact.context }] });
  expect(changed.ok).toBe(true);
  const second = (await getOwnCvLibrary(user.id))!;
  const evidence = await getLibraryEvidence(user.id, second);
  expect(second.version).toBeGreaterThan(first.version);
  expect(evidence.entries.find(entry => entry.entryId === career.selected!.record.id)).toMatchObject({ source: "rules", provisional: true });
});

it("shows the refusal the worker recorded instead of waiting for a pass that will not run", async () => {
  await save(libraryFixture(["Led a team of nine"]), 0);
  expect(await rescoreLibrary({ ok: true }, new FormData())).toEqual({ ok: true });
  const stored = (await getOwnCvLibrary(user.id))!;
  const refusal = "Library evidence review needs about $0.12 of AI budget; your budget of $5 has $0.00 left this month (it resets on the 1st). Raise it on Settings, or ask an administrator.";
  await database
    .update(schema.tasks)
    .set({ status: "done", result: { reviewed: 0, reused: 0, skipped: "budget", message: refusal, cost: 0 } })
    .where(and(eq(schema.tasks.type, "review_library"), sql`${schema.tasks.payload}->>'userId' = ${user.id}`));
  const evidence = await getLibraryEvidence(user.id, stored);
  expect(evidence.refusal).toBe(refusal);
  expect(evidence.evaluating).toBe(false);
  expect(evidence.entries[0]!.evaluating).toBe(false);
});

it("never reads another account's versions or answers for them", async () => {
  await save(libraryFixture(["Led a team"]), 0);
  const mine = (await getOwnCvLibrary(user.id))!;
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "someone-else@example.com", "member");

  expect(await ownsLibraryVersion(other.user.id, mine.version)).toBe(false);
  expect(await libraryReviewSignature(other.user.id, mine.version)).toBe("0:");

  // The route is asked for a version the signed-in account has not saved.
  session = other.cookie;
  expect((await signatureOf(mine.version)).status).toBe(404);
  expect((await signatureOf("nonsense")).status).toBe(400);
});

/**
 * Runs last on purpose: it hides a table the other tests need, and a migrated database never
 * un-migrates, so nothing after it should be asking the queries to disbelieve what they can see.
 */
it("renders without scores on a database the worker has not migrated for reviews yet", async () => {
  await save(libraryFixture(["Led a team of nine"]), 0);
  const stored = (await getOwnCvLibrary(user.id))!;
  await database.execute(sql`alter table cv_library_reviews rename to cv_library_reviews_hidden`);
  try {
    const evidence = await getLibraryEvidence(user.id, stored);
    // The baseline still stands: the reviews are what is missing, not the person's own tags.
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({ source: "rules", provisional: true });
    expect(await libraryReviewSignature(user.id, stored.version)).toBe("");
    expect((await signatureOf(stored.version)).body.signature).toBe("");
  } finally {
    await database.execute(sql`alter table cv_library_reviews_hidden rename to cv_library_reviews`);
  }
});
