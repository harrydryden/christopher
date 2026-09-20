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
import { createDb, schema, upsertLibraryReviews, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { and, desc, eq, sql } from "drizzle-orm";
import { libraryEntryInputHash, rulesLibraryReview } from "@christopher/core/library-review";
import type { CvLibrary } from "@christopher/core/cv";
import { signInTestUser } from "@/test/auth";
import type { User } from "@christopher/db/schema";

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
import {
  getLibraryEvidence,
  getLibraryVersionContents,
  getOwnCvLibrary,
  libraryReviewSignature,
  listLibraryVersions,
  ownsLibraryVersion,
} from "./queries/cv";

const ACME = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };

function libraryFixture(rows: string[], facets: Record<string, string> = {}): CvLibrary {
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
      ...(Object.keys(facets).length ? { rowFacets: facets as CvLibrary["entries"][number]["rowFacets"] } : {}),
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
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
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
    "Led a team of nine through a move to one site": "responsibility",
    "Cut handovers by 40%": "metric",
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
  // Two rows covering two of the six facets: the baseline reads Weak, and the line names it.
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
      prompts: ["What did the move to one site achieve?", "What changed as a result?"],
      score: 62,
      rating: "good",
    },
  }]);

  const after = await signatureOf(stored.version);
  expect(after.body.signature).not.toBe(before.body.signature);

  const scored = await getLibraryEvidence(user.id, stored);
  expect(scored.entries[0]).toMatchObject({ source: "model", provisional: false, evaluating: false, score: 62, rating: "good" });
  expect(scored.evaluating).toBe(false);
  expect(scored.line).toBe("Evidence: Good");
  // Each prompt is one question; the one that is a facet question carries its facet for the
  // "Add a row for this" control, and the one the model wrote itself does not.
  expect(scored.entries[0]!.prompts).toEqual([
    { question: "What did the move to one site achieve?", facet: null },
    { question: "What changed as a result?", facet: "outcome" },
  ]);
});

it("treats a review of wording that has since been edited as no review at all", async () => {
  await save(libraryFixture(["Led a team of nine"]), 0);
  const first = (await getOwnCvLibrary(user.id))!;
  await upsertLibraryReviews(database, user.id, first.version, [{
    entryId: "acme-block",
    inputHash: libraryEntryInputHash(first.content.entries[0]!, ACME),
    source: "model",
    model: "test-model",
    review: { ...rulesLibraryReview(first.content.entries[0]!, first.content), score: 70, rating: "good" },
  }]);
  expect((await getLibraryEvidence(user.id, first)).entries[0]).toMatchObject({ source: "model", score: 70 });

  await save(libraryFixture(["Led a team of nine through a move to one site"]), first.version);
  const second = (await getOwnCvLibrary(user.id))!;
  const evidence = await getLibraryEvidence(user.id, second);
  expect(evidence.entries[0]).toMatchObject({ source: "rules", provisional: true });
  expect(evidence.entries[0]!.score).not.toBe(70);
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
