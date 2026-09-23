/**
 * The Library page's reads, against the database: the evidence it shows, the poll token it hands
 * its poller, and the version history it compares.
 *
 * The save, the review row and the queue row are all real here, because the three things that can
 * go wrong are wiring rather than arithmetic: a review stored against wording that has since been
 * edited must not be shown, a signature that does not move when a review lands leaves a page
 * saying "Evaluating…" for good, and a diff of a version another account saved must not be
 * readable at all.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, upsertLibraryReviews, type Db } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { and, desc, eq, sql } from "drizzle-orm";
import { libraryEntryInputHash, rulesLibraryReview } from "@ava/core/library-review";
import { groupCvLibrary, type CvLibrary, type EvidenceFacet } from "@ava/core/cv";
import { cvTailoringEvidence } from "@ava/core/cv-tailoring";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { saveCvLibrary } from "@/app/actions/cv";
import { GET as reviewsRoute } from "@/app/api/cv/library/reviews/route";
import { diffCvLibraries, requestedDiff } from "./cv-library-diff";
import { cvLibraryReadiness } from "./cv-ready";
import { archivedBlocks, editableEmployment, openStoredLibrary, removeJob, restoreJob } from "./cv-library-rows";
import {
  getLibraryEvidence,
  getLibraryVersionContents,
  getOwnCvLibrary,
  libraryReviewSignature,
  listLibraryVersions,
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
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/ava_test");
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

  // The save queued the pass, so every entry reads as evaluating against the baseline computed
  // here rather than as scored.
  const queued = await getLibraryEvidence(user.id, stored);
  const baseline = rulesLibraryReview(stored.content.entries[0]!, stored.content);
  expect(queued.entries).toHaveLength(1);
  expect(queued.entries[0]).toMatchObject({
    entryId: "acme-block",
    employmentId: "acme",
    source: "rules",
    provisional: true,
    evaluating: true,
    score: baseline.score,
    rating: baseline.rating,
  });
  expect(queued.evaluating).toBe(true);
  // Two rows covering two of the six types: the baseline reads Weak, and the line names it.
  expect(baseline.rating).toBe("weak");
  expect(queued.line).toBe("Evidence: Weak · 1 job is Weak");
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
      // 31.25, both rows specific is 25, one of two quantified is 12.5: 69, which is Good.
      rows: [
        { ...baseline.rows[0]!, facets: ["responsibility"], specific: true },
        { ...baseline.rows[1]!, facets: ["outcome", "metric"], specific: true, quantified: true, outcomeLinked: true },
      ],
      prompts: ["What did the move to one site achieve?", "What changed as a result?"],
      score: 69,
      rating: "good",
    },
  }]);

  const after = await signatureOf(stored.version);
  expect(after.body.signature).not.toBe(before.body.signature);

  const scored = await getLibraryEvidence(user.id, stored);
  expect(scored.entries[0]).toMatchObject({ source: "model", provisional: false, evaluating: false, score: 69, rating: "good" });
  expect(scored.evaluating).toBe(false);
  expect(scored.line).toBe("Evidence: Good");
  // Each prompt is one question; the one that is a type's own question carries that type for the
  // "Add a row for this" control, and the one the model wrote itself does not.
  expect(scored.entries[0]!.prompts).toEqual([
    { question: "What did the move to one site achieve?", facet: null },
    { question: "What changed as a result?", facet: "outcome" },
  ]);
});

it("reads a review an earlier release stored, in today's shape", async () => {
  // Every account already reviewed carries reviews whose rows name one `facet`, as a string, and
  // whose row tags have not changed — so they still match by hash and are what the page shows.
  // Read as they were written, their rows would carry no types at all.
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
});

it("archives a removed job's evidence instead of deleting it, and shows it nowhere again", async () => {
  // The one destructive motion the editor has. The rows have to survive in the saved versions and
  // in the CVs already built from them, and appear in nothing that is built or scored from here.
  await save(libraryFixture(["Led a team of nine through a move to one site"]), 0);
  const before = (await getOwnCvLibrary(user.id))!;

  // What the editor posts: `removeJob` over what the page opened.
  const posted = removeJob(openStoredLibrary(before.content), "acme");
  expect(posted.entries.map(entry => entry.status)).toEqual(["inactive"]);
  expect(await save(posted, before.version)).toEqual({ ok: true });

  const after = (await getOwnCvLibrary(user.id))!;
  // Kept, as inactive, with the employment record the block points at.
  expect(after.content.entries.map(entry => [entry.id, entry.status])).toEqual([["acme-block", "inactive"]]);
  expect(after.content.employment?.map(job => job.id)).toEqual(["acme"]);
  expect(after.content.entries[0]!.details).toBe("Led a team of nine through a move to one site");

  // Not on the screen, not scored, not counted, and not something a CV could be built from.
  const opened = openStoredLibrary(after.content);
  expect(cvLibraryReadiness(opened).ready).toBe(false);
  expect((await getLibraryEvidence(user.id, after)).entries).toEqual([]);
  expect(cvTailoringEvidence(after.content).filter(item => item.entryId)).toEqual([]);
  expect(() => groupCvLibrary(opened)).toThrow("Confirm at least one responsibility or outcome");

  // And the history says what that save did, rather than comparing equal to the version before it.
  const contents = await getLibraryVersionContents(user.id, [before.version, after.version]);
  const diff = diffCvLibraries(
    openStoredLibrary(contents.get(before.version)),
    openStoredLibrary(contents.get(after.version)),
    before.version,
    after.version,
  );
  expect(diff.blocksRemoved).toEqual(["Operations Director · Acme · Jan 2023 – Present"]);
});

it("puts a removed job back, with its wording and its employment record intact", async () => {
  // The way back from the one destructive motion the editor has. A removal is recoverable for as
  // long as the block is stored, and the save that recovers it is an ordinary save.
  await save(libraryFixture(["Led a team of nine through a move to one site"]), 0);
  const before = (await getOwnCvLibrary(user.id))!;
  expect(await save(removeJob(openStoredLibrary(before.content), "acme"), before.version)).toEqual({ ok: true });

  const archived = (await getOwnCvLibrary(user.id))!;
  // What the Experience tab offers: the job by its heading, and the rows that come back with it.
  expect(archivedBlocks(openStoredLibrary(archived.content))).toEqual([{
    entryId: "acme-block",
    employmentId: "acme",
    heading: "Operations Director · Acme · Jan 2023 – Present",
    rows: 1,
  }]);

  // Typed back in rather than restored, the new job collides with the record the removal kept.
  // The refusal is about a row that is not on the screen, so it says where that row is.
  const retyped = openStoredLibrary(archived.content);
  const duplicate = await save({ ...retyped, employment: [...retyped.employment!, { ...ACME, id: "acme-again" }] }, archived.version);
  expect(duplicate).toEqual({ ok: false, error: "This job is in Archived jobs below; restore it instead of adding it again." });

  // Restored and saved: the stored block is evidence again, unchanged, and so is its record.
  expect(await save(restoreJob(openStoredLibrary(archived.content), "acme"), archived.version)).toEqual({ ok: true });
  const after = (await getOwnCvLibrary(user.id))!;
  expect(after.content.entries.map(entry => [entry.id, entry.status])).toEqual([["acme-block", "active"]]);
  expect(after.content.entries[0]!.details).toBe("Led a team of nine through a move to one site");
  expect(after.content.entries[0]!.confirmedResponsibilities).toEqual(["Led a team of nine through a move to one site"]);
  expect(after.content.employment?.map(job => job.id)).toEqual(["acme"]);

  const opened = openStoredLibrary(after.content);
  expect(editableEmployment(opened).map(job => job.id)).toEqual(["acme"]);
  expect(archivedBlocks(opened)).toEqual([]);
  // Counted again by everything that reads the library: the CV it was holding back can be built.
  expect(cvLibraryReadiness(opened).ready).toBe(true);
  expect((await getLibraryEvidence(user.id, after)).entries.map(entry => entry.entryId)).toEqual(["acme-block"]);
});

it("treats a review of wording that has since been edited as no review at all", async () => {
  await save(libraryFixture(["Led a team of nine"]), 0);
  const first = (await getOwnCvLibrary(user.id))!;
  await upsertLibraryReviews(database, user.id, first.version, [{
    entryId: "acme-block",
    inputHash: libraryEntryInputHash(first.content.entries[0]!, ACME),
    source: "model",
    model: "test-model",
    review: rulesLibraryReview(first.content.entries[0]!, first.content),
  }]);
  expect((await getLibraryEvidence(user.id, first)).entries[0]).toMatchObject({ source: "model", provisional: false });

  await save(libraryFixture(["Led a team of nine through a move to one site"]), first.version);
  const second = (await getOwnCvLibrary(user.id))!;
  const evidence = await getLibraryEvidence(user.id, second);
  expect(evidence.entries[0]).toMatchObject({ source: "rules", provisional: true });
});

it("shows the refusal the worker recorded instead of waiting for a pass that will not run", async () => {
  await save(libraryFixture(["Led a team of nine"]), 0);
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

it("lists this account's versions newest first and compares two of them", async () => {
  await save(libraryFixture(["Led a team"]), 0);
  await save(libraryFixture(["Led a team of nine", "Cut handovers by 40%"]), 1);
  await save(libraryFixture(["Led a team of nine", "Cut handovers by 40%", "Shipped the new rota in March"]), 2);

  const versions = await listLibraryVersions(user.id);
  expect(versions.map(row => row.version)).toEqual([3, 2, 1]);
  expect(versions[0]!.createdAt).toBeInstanceOf(Date);

  const wanted = requestedDiff({ diff: "1,3" }, versions.map(row => row.version))!;
  const contents = await getLibraryVersionContents(user.id, [wanted.from, wanted.to]);
  const diff = diffCvLibraries(contents.get(1)!, contents.get(3)!, 1, 3);
  expect(diff.blocks).toHaveLength(1);
  expect(diff.blocks[0]).toMatchObject({
    added: ["Cut handovers by 40%", "Shipped the new rota in March"],
    removed: [],
    changed: [{ before: "Led a team", after: "Led a team of nine" }],
  });
});

it("never reads another account's versions or answers for them", async () => {
  await save(libraryFixture(["Led a team"]), 0);
  const mine = (await getOwnCvLibrary(user.id))!;
  const other = await signInTestUser(database, process.env.SESSION_SECRET!, "someone-else@example.com", "member");

  expect(await ownsLibraryVersion(other.user.id, mine.version)).toBe(false);
  expect(await getLibraryVersionContents(other.user.id, [mine.version])).toEqual(new Map());
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
