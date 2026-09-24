import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb } from "@/test/db";
import {
  actionCvs,
  addCvShareComment,
  completeCv,
  createCvShare,
  createDb,
  CvBuildInFlightError,
  resolveCvShareComment,
  revokeCvShare,
  cvRoleKey,
  nextCvRevision,
  schema,
  type Db,
} from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { ensureTestUser, signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let user: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (session ? { value: session } : undefined),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
import { manageCvs } from "@/app/actions/cv";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "cv-retention-test-secret";
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate cv_drafts, cv_versions, applications, sessions cascade`);
  ({ user, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
});
async function draft(
  n: number,
  extra: Partial<typeof schema.cvDrafts.$inferInsert> = {},
) {
  const [row] = await database
    .insert(schema.cvDrafts)
    .values({
      userId: user.id,
      companyName: "Example",
      jobTitle: "Operations Director",
      jobDescription: "Lead operations",
      libraryVersion: 1,
      librarySnapshot: {
        name: "Example",
        contact: "",
        profile: "",
        entries: [],
      },
      model: "test",
      revision: n,
      createdAt: new Date(2026, 0, n),
      ...extra,
    })
    .returning();
  return row!;
}
const finish = (id: string) =>
  database.transaction((tx) => completeCv(tx, id, {}));
const rows = () =>
  database.select().from(schema.cvDrafts).orderBy(schema.cvDrafts.createdAt);
/** What `requestCv` and `saveCvDraft` do before inserting the revision they just claimed. */
const allocate = () =>
  database.transaction((tx) =>
    nextCvRevision(tx, {
      userId: user.id,
      companyName: "Example",
      jobTitle: "Operations Director",
    }),
  );

/**
 * The retention rule itself, asserted wherever a test leaves the tables at rest: per account,
 * company and role there is at most one saved CV and at most one archive.
 */
async function expectOneSavedAndOneArchive() {
  const key = cvRoleKey(
    schema.cvDrafts.userId,
    schema.cvDrafts.companyName,
    schema.cvDrafts.jobTitle,
  );
  const groups = await database
    .select({
      key,
      saved: sql<number>`count(*) filter (where ${schema.cvDrafts.status} = 'ready' and ${schema.cvDrafts.archivedAt} is null)::int`,
      archived: sql<number>`count(*) filter (where ${schema.cvDrafts.archivedAt} is not null)::int`,
    })
    .from(schema.cvDrafts)
    .groupBy(key);
  expect(
    groups.filter((group) => group.saved > 1 || group.archived > 1),
  ).toEqual([]);
}

/**
 * Production's Humanoid role: one ready archive, one ready current, and three dead attempts —
 * two fresh builds that failed, and a rebuild of the current one that failed.
 */
async function productionRole() {
  const archive = await draft(1, {
    status: "ready",
    archivedAt: new Date(2026, 0, 1),
  });
  const failedBuild = await draft(2, { status: "failed" });
  const failedRetry = await draft(3, { status: "failed" });
  const current = await draft(4, { status: "ready" });
  const failedRebuild = await draft(5, {
    status: "failed",
    parentId: current.id,
  });
  return { archive, failedBuild, failedRetry, current, failedRebuild };
}

it("drops the superseded failed attempts when the next revision is allocated", async () => {
  const { archive, current, failedRebuild } = await productionRole();
  expect(await allocate()).toBe(6);
  // The newest failure is still worth reopening; the saved CV and its archive are untouched.
  expect((await rows()).map((row) => row.id)).toEqual([
    archive.id,
    current.id,
    failedRebuild.id,
  ]);
  await expectOneSavedAndOneArchive();
});
it("spares the failed draft an edit is written from, even with a newer failure beside it", async () => {
  const { archive, failedBuild, failedRetry, current, failedRebuild } =
    await productionRole();
  await database
    .update(schema.cvDrafts)
    .set({
      content: {
        name: "Example",
        contact: "London",
        summary: "Operations leader",
        sections: [
          {
            entryId: "one",
            kind: "experience" as const,
            heading: "Director",
            bullets: ["Led a team"],
          },
        ],
        gaps: [],
      },
    })
    .where(eq(schema.cvDrafts.id, failedRetry.id));
  const { saveCvDraft } = await import("@/app/actions/cv");
  const form = new FormData();
  form.set("summary", "Updated operations profile");
  await expect(
    saveCvDraft(failedRetry.id, { ok: true }, form),
  ).rejects.toThrow("redirect:/cv/");
  const saved = (await rows()).at(-1)!;
  expect(saved.revision).toBe(6);
  expect(saved.parentId).toBe(failedRetry.id);
  expect(saved.content!.summary).toBe("Updated operations profile");
  // Only the attempt nothing is reading goes; the source and the newest failure both stay.
  expect((await rows()).map((row) => row.id)).toEqual([
    archive.id,
    failedRetry.id,
    current.id,
    failedRebuild.id,
    saved.id,
  ]);
  expect(
    (await rows()).some((row) => row.id === failedBuild.id),
  ).toBe(false);
  await finish(saved.id);
  expect((await rows()).map((row) => [row.id, Boolean(row.archivedAt)])).toEqual(
    [
      [current.id, true],
      [saved.id, false],
    ],
  );
  await expectOneSavedAndOneArchive();
});
it("leaves only the new saved CV and one archive when a revision publishes", async () => {
  const { current } = await productionRole();
  expect(await allocate()).toBe(6);
  const next = await draft(6);
  await finish(next.id);
  expect((await rows()).map((row) => [row.id, Boolean(row.archivedAt)])).toEqual(
    [
      [current.id, true],
      [next.id, false],
    ],
  );
  // The ledger keeps every identifier it issued, so a cleanup cannot reuse a version number.
  expect(await database.select().from(schema.cvVersions)).toHaveLength(6);
  await expectOneSavedAndOneArchive();
});
it("never removes a build a worker still holds a lease on", async () => {
  const { archive, current, failedRebuild } = await productionRole();
  const queued = await draft(6);
  const generating = await draft(7, { status: "generating" });
  expect(await allocate()).toBe(8);
  expect((await rows()).map((row) => row.id)).toEqual([
    archive.id,
    current.id,
    failedRebuild.id,
    queued.id,
    generating.id,
  ]);
  const next = await draft(8);
  await finish(next.id);
  expect((await rows()).map((row) => row.id)).toEqual([
    current.id,
    queued.id,
    generating.id,
    next.id,
  ]);
  await expectOneSavedAndOneArchive();
});
it("keeps submitted PDFs when retention removes the revisions they came from", async () => {
  const { archive, failedRetry } = await productionRole();
  const submitted = (cvId: string, appliedOn: string) => ({
    userId: user.id,
    cvId,
    companyName: "Example",
    jobTitle: "Operations Director",
    appliedOn,
    pdfBase64: `JVBERi0${cvId.slice(0, 4)}`,
    history: [{ status: "applied", at: appliedOn, notes: "Submitted" }],
  });
  const frozen = [
    submitted(archive.id, "2026-01-01"),
    submitted(failedRetry.id, "2026-01-03"),
  ];
  await database.insert(schema.applications).values(frozen);
  expect(await allocate()).toBe(6);
  const next = await draft(6);
  await finish(next.id);
  expect(
    (
      await database
        .select()
        .from(schema.applications)
        .orderBy(schema.applications.appliedOn)
    ).map((application) => ({
      pdfBase64: application.pdfBase64,
      cvId: application.cvId,
      history: application.history,
    })),
  ).toEqual(
    frozen.map((application) => ({
      pdfBase64: application.pdfBase64,
      cvId: null,
      history: application.history,
    })),
  );
});
it("keeps the working CV while a replacement is pending or fails, then rolls one archive", async () => {
  const first = await draft(1, { status: "ready" });
  const next = await draft(2);
  expect((await rows())[0]!.archivedAt).toBeNull();
  await database
    .update(schema.cvDrafts)
    .set({ status: "failed" })
    .where(eq(schema.cvDrafts.id, next.id));
  expect((await rows())[0]!.archivedAt).toBeNull();
  await finish(next.id);
  expect((await rows()).map((row) => Boolean(row.archivedAt))).toEqual([
    true,
    false,
  ]);
  const latest = await draft(3);
  await finish(latest.id);
  expect((await rows()).map((row) => row.id)).toEqual([next.id, latest.id]);
  expect(await finish(first.id)).toBe(false);
  await expectOneSavedAndOneArchive();
});
it("serialises concurrent completions and ignores out-of-order older builds", async () => {
  const drafts = await Promise.all([draft(1), draft(2), draft(3)]);
  await Promise.all([
    finish(drafts[2]!.id),
    finish(drafts[0]!.id),
    finish(drafts[1]!.id),
  ]);
  expect(
    (await rows()).map((row) => [row.revision, Boolean(row.archivedAt)]),
  ).toEqual([
    [2, true],
    [3, false],
  ]);
  await expectOneSavedAndOneArchive();
});
it("groups company and role regardless of case or spacing, without touching another role/company", async () => {
  await draft(1, { status: "ready" });
  const second = await draft(2, {
    companyName: "\t EXAMPLE \n",
    jobTitle: "operations   director",
  });
  await draft(3, { companyName: "Different", status: "ready" });
  await draft(4, { jobTitle: "Finance Director", status: "ready" });
  await finish(second.id);
  expect(
    (await rows()).filter((row) => !row.archivedAt && row.status === "ready"),
  ).toHaveLength(3);
  expect((await rows())[0]!.archivedAt).not.toBeNull();
  await expectOneSavedAndOneArchive();
});
it("restores by swapping the current and archived CV; manual archiving replaces the archive", async () => {
  const first = await draft(1, { status: "ready", archivedAt: new Date() });
  const second = await draft(2, { status: "ready" });
  await actionCvs(database, user.id, [first.id], "restore");
  expect((await rows()).map((row) => Boolean(row.archivedAt))).toEqual([
    false,
    true,
  ]);
  await actionCvs(database, user.id, [first.id], "archive");
  expect((await rows()).map((row) => row.id)).toEqual([first.id]);
  expect((await rows())[0]!.archivedAt).not.toBeNull();
});
it("respects archive during generation and never resurrects a deleted build", async () => {
  const current = await draft(1, { status: "ready" });
  const pending = await draft(2);
  await actionCvs(database, user.id, [pending.id], "archive");
  await finish(pending.id);
  expect(
    (await rows()).find((row) => row.id === current.id)!.archivedAt,
  ).toBeNull();
  expect(
    (await rows()).find((row) => row.id === pending.id)!.archivedAt,
  ).not.toBeNull();
  await expectOneSavedAndOneArchive();
  await actionCvs(database, user.id, [pending.id], "delete");
  expect(await finish(pending.id)).toBe(false);
});
it("preserves submitted PDFs and application history when retention or bulk deletion removes a CV", async () => {
  const first = await draft(1, { status: "ready", archivedAt: new Date() });
  const current = await draft(2, { status: "ready" });
  const frozen = {
    userId: user.id,
    cvId: first.id,
    companyName: "Example",
    jobTitle: "Operations Director",
    appliedOn: "2026-01-01",
    pdfBase64: "JVBERi1mcm96ZW4=",
    history: [{ status: "applied", at: "2026-01-01", notes: "Submitted" }],
  };
  await database.insert(schema.applications).values(frozen);
  const newer = await draft(3);
  await finish(newer.id);
  const [application] = await database.select().from(schema.applications);
  expect(application).toMatchObject({ ...frozen, cvId: null });
  await expectOneSavedAndOneArchive();
  await actionCvs(database, user.id, [current.id, newer.id], "delete");
  expect(await rows()).toHaveLength(0);
  expect((await database.select().from(schema.applications))[0]).toEqual(
    application,
  );
});
it("validates all bulk IDs before changing anything and requires a session", async () => {
  const first = await draft(1, { status: "ready" });
  const second = await draft(2, {
    status: "ready",
    jobTitle: "Finance Director",
  });
  const form = new FormData();
  form.set("action", "delete");
  form.append("cvId", first.id);
  form.append("cvId", "invalid");
  expect((await manageCvs({ ok: true }, form)).ok).toBe(false);
  expect(await rows()).toHaveLength(2);
  form.delete("cvId");
  form.append("cvId", first.id);
  form.append("cvId", second.id);
  session = undefined;
  await expect(manageCvs({ ok: true }, form)).rejects.toThrow();
  expect(await rows()).toHaveLength(2);
  ({ cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!));
  expect(await manageCvs({ ok: true }, form)).toEqual({ ok: true });
  expect(await rows()).toHaveLength(0);
});
it("keeps the newest selected archive when a bulk action includes the same role twice", async () => {
  const one = await draft(1),
    two = await draft(2);
  await actionCvs(database, user.id, [one.id, two.id], "archive");
  expect(
    (await rows()).filter((row) => row.archivedAt).map((row) => row.id),
  ).toEqual([two.id]);
});
it("allocates distinct increasing versions across fresh builds and repeated edits", async () => {
  await draft(3, { status: "ready" });
  const versions = await Promise.all(
    [1, 2].map(() =>
      database.transaction(async (tx) => {
        const revision = await nextCvRevision(tx, {
          userId: user.id,
          companyName: "Example",
          jobTitle: "Operations Director",
        });
        await tx.insert(schema.cvDrafts).values({
          ...(await rows())[0]!,
          id: undefined,
          status: "queued",
          revision,
        });
        return revision;
      }),
    ),
  );
  expect(versions.sort()).toEqual([4, 5]);
});
it("backfills legacy duplicates without restoring an intentionally archived newer CV", async () => {
  const current = await draft(1, { status: "ready" });
  await draft(2, { status: "ready", archivedAt: new Date(2026, 1, 1) });
  const chosenArchive = await draft(3, {
    status: "failed",
    archivedAt: new Date(2026, 1, 2),
  });
  const migration = await readFile(
    new URL(
      "../../../packages/db/drizzle/0017_cv_retention.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint").slice(3))
    await database.execute(sql.raw(statement));
  expect((await rows()).map((row) => row.id)).toEqual([
    current.id,
    chosenArchive.id,
  ]);
  await expectOneSavedAndOneArchive();
});

it("bulk archiving a current CV and its pending replacement leaves only the selected newest archive", async () => {
  const current = await draft(1, { status: "ready" }),
    pending = await draft(2);
  await actionCvs(database, user.id, [current.id, pending.id], "archive");
  expect((await rows()).map((row) => row.id)).toEqual([pending.id]);
  expect((await rows())[0]!.archivedAt).not.toBeNull();
  await expectOneSavedAndOneArchive();
});

it("archives the chosen current CV after a restore, replacing the previous archive", async () => {
  const current = await draft(1, { status: "ready" });
  await draft(2, { status: "ready", archivedAt: new Date() });
  const replacement = await draft(3);
  await finish(replacement.id);
  expect((await rows()).map((row) => row.id)).toEqual([
    current.id,
    replacement.id,
  ]);
  expect((await rows())[0]!.archivedAt).not.toBeNull();
  await expectOneSavedAndOneArchive();
});

it("does not modify a ready CV or its archive timestamp on duplicate completion", async () => {
  const archivedAt = new Date(2026, 0, 2);
  const archive = await draft(1, { status: "ready", archivedAt });
  const current = await draft(2, { status: "ready" });
  await database.transaction((tx) =>
    completeCv(tx, current.id, { revision: 999 }),
  );
  const saved = await rows();
  expect(saved.find((row) => row.id === current.id)!.revision).toBe(2);
  expect(saved.find((row) => row.id === archive.id)!.archivedAt).toEqual(
    archivedAt,
  );
});
it("does not reset an existing archive timestamp when an older build completes late", async () => {
  const old = await draft(1);
  const archivedAt = new Date(2026, 0, 4);
  const archive = await draft(2, { status: "ready", archivedAt });
  await draft(3, { status: "ready" });
  await finish(old.id);
  expect(
    (await rows()).find((row) => row.id === archive.id)!.archivedAt,
  ).toEqual(archivedAt);
  await expectOneSavedAndOneArchive();
});
it("serialises crossed bulk requests without deadlocks or extra current CVs", async () => {
  const a = await draft(1, { status: "ready" });
  const b = await draft(2, { status: "ready", companyName: "Different" });
  await Promise.all([
    actionCvs(database, user.id, [a.id, b.id], "archive"),
    actionCvs(database, user.id, [b.id, a.id], "archive"),
  ]);
  expect((await rows()).every((row) => row.archivedAt)).toBe(true);
  await Promise.all([
    actionCvs(database, user.id, [b.id, a.id], "restore"),
    actionCvs(database, user.id, [a.id, b.id], "restore"),
  ]);
  expect((await rows()).every((row) => !row.archivedAt)).toBe(true);
});
it("allows an unrelated role to complete while another role is locked", async () => {
  const a = await draft(1),
    b = await draft(2, { companyName: "Different" });
  const { lockCvLifecycle } = await import("@ava/db");
  await database.transaction(async (tx) => {
    await lockCvLifecycle(tx, a);
    await database.transaction(async (other) => {
      await other.execute(sql`set local lock_timeout = '500ms'`);
      expect(await completeCv(other, b.id, {})).toBe(true);
    });
  });
});
it("uses collision-free role keys and an indexed lookup", async () => {
  const { cvRoleKey } = await import("@ava/db");
  const result = await database.execute(
    sql`select ${cvRoleKey(user.id, "a:b", "c")} as a, ${cvRoleKey(user.id, "a", "b:c")} as b`,
  );
  expect(result.rows[0]!.a).not.toBe(result.rows[0]!.b);
  await database.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const plan = await tx.execute(
      sql`explain select id from cv_drafts where ${cvRoleKey(schema.cvDrafts.userId, schema.cvDrafts.companyName, schema.cvDrafts.jobTitle)} = ${cvRoleKey(user.id, "Example", "Operations Director")}`,
    );
    expect(JSON.stringify(plan.rows)).toContain("cv_drafts_role_key_idx");
  });
});
it("returns a safe error and logs no SQL or CV contents when a bulk operation fails", async () => {
  const current = await draft(1, { status: "ready" });
  const execute = vi
    .spyOn(database, "transaction")
    .mockRejectedValueOnce(
      new Error("Failed query: secret CV contents and database details"),
    );
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const form = new FormData();
    form.append("cvId", current.id);
    form.set("action", "delete");
    const response = await manageCvs({ ok: true }, form);
    expect(response).toEqual({
      ok: false,
      error: "Could not update the selected CVs. Please try again.",
    });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(
      /secret|database details/,
    );
    expect(await rows()).toHaveLength(1);
  } finally {
    execute.mockRestore();
    logger.mockRestore();
  }
});

it("rejects a stale editor save when its source was deleted before the transaction began", async () => {
  const content = {
    name: "Example",
    contact: "London",
    summary: "Operations leader",
    sections: [
      {
        entryId: "one",
        kind: "experience" as const,
        heading: "Director",
        bullets: ["Led a team"],
      },
    ],
    gaps: [],
  };
  const current = await draft(1, { status: "ready", content });
  const original = database.transaction.bind(database);
  const transaction = vi
    .spyOn(database, "transaction")
    .mockImplementationOnce(async (work, config) => {
      await database
        .delete(schema.cvDrafts)
        .where(eq(schema.cvDrafts.id, current.id));
      return original(work, config);
    });
  try {
    const { saveCvDraft } = await import("@/app/actions/cv");
    const form = new FormData();
    form.set("summary", "Updated operations profile");
    expect(await saveCvDraft(current.id, { ok: true }, form)).toEqual({
      ok: false,
      error: "This CV was deleted. Open the latest saved CV before editing.",
    });
    expect(await rows()).toHaveLength(0);
  } finally {
    transaction.mockRestore();
  }
});

it("returns authoritative table rows through the authenticated JSON mutation endpoint", async () => {
  const current = await draft(1, { status: "ready" });
  const { POST } = await import("@/app/api/cv/manage/route");
  const request = (action: string) =>
    new Request("https://example.test/api/cv/manage", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids: [current.id], action }),
    });
  const archived = await POST(request("archive"));
  expect(archived.status).toBe(200);
  expect(await archived.json()).toMatchObject({
    ok: true,
    pages: {
      saved: { total: 0, rows: [] },
      archived: { total: 1, rows: [{ id: current.id }] },
    },
  });
  const restored = await POST(request("restore"));
  expect(await restored.json()).toMatchObject({
    ok: true,
    pages: {
      saved: { total: 1, rows: [{ id: current.id }] },
      archived: { total: 0, rows: [] },
    },
  });
  const deleted = await POST(request("delete"));
  expect(await deleted.json()).toMatchObject({
    ok: true,
    pages: { saved: { total: 0, rows: [] }, archived: { total: 0, rows: [] } },
  });
});
it("rejects unauthenticated, cross-origin, malformed and oversized JSON mutations", async () => {
  const current = await draft(1, { status: "ready" });
  const { POST } = await import("@/app/api/cv/manage/route");
  const payload = JSON.stringify({ ids: [current.id], action: "delete" });
  const request = (
    body: string,
    origin = "https://example.test",
    contentType = "application/json",
  ) =>
    new Request("https://example.test/api/cv/manage", {
      method: "POST",
      headers: { origin, "content-type": contentType },
      body,
    });
  expect((await POST(request(payload, "https://attacker.test"))).status).toBe(
    403,
  );
  expect(
    (await POST(request(payload, "https://example.test", "text/plain"))).status,
  ).toBe(415);
  expect((await POST(request("{"))).status).toBe(400);
  expect((await POST(request("x".repeat(8193)))).status).toBe(413);
  expect(
    (
      await POST(
        request(JSON.stringify({ ids: [current.id], action: "invalid" })),
      )
    ).status,
  ).toBe(400);
  session = undefined;
  expect((await POST(request(payload))).status).toBe(401);
  expect(await rows()).toHaveLength(1);
});

it("matches the actual request host when the framework URL uses an internal hostname", async () => {
  const current = await draft(1, { status: "ready" });
  const { POST } = await import("@/app/api/cv/manage/route");
  const response = await POST(
    new Request("http://localhost:3123/api/cv/manage", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3123",
        origin: "http://127.0.0.1:3123",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids: [current.id], action: "archive" }),
    }),
  );
  expect(response.status).toBe(200);
});

it("allocates daily versions atomically and preserves numbers after deletion", async () => {
  const createdAt = new Date("2026-09-19T12:00:00Z");
  const first = await draft(1, { createdAt });
  const [second, third] = await Promise.all([
    draft(2, { createdAt, companyName: " EXAMPLE " }),
    draft(3, { createdAt }),
  ]);
  const { dailyCvVersions } = await import("./queries/cv");
  let versions = await dailyCvVersions(database, [first.id, second.id, third.id]);
  expect(versions.get(first.id)).toBe(1);
  expect([versions.get(second.id), versions.get(third.id)].sort()).toEqual([2, 3]);
  await actionCvs(database, user.id, [first.id, second.id, third.id], "delete");
  const fourth = await draft(4, { createdAt });
  const nextDay = await draft(5, { createdAt: new Date("2026-09-20T00:00:00Z") });
  const otherRole = await draft(6, { createdAt, jobTitle: "Other role" });
  versions = await dailyCvVersions(database, [fourth.id, nextDay.id, otherRole.id]);
  expect(versions.get(fourth.id)).toBe(4);
  expect(versions.get(nextDay.id)).toBe(1);
  expect(versions.get(otherRole.id)).toBe(1);
  await finish(fourth.id);
  await actionCvs(database, user.id, [fourth.id], "archive");
  await actionCvs(database, user.id, [fourth.id], "restore");
  expect((await dailyCvVersions(database, [fourth.id])).get(fourth.id)).toBe(4);
});

/** A link onto one revision, as the workspace opens one, and optionally a note left through it. */
async function shareOf(draftId: string, owner = user.id, note?: string) {
  const share = await createCvShare(database, {
    userId: owner, draftId, tokenHash: `hash-${draftId}-${owner}`,
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });
  const comment = note
    ? await addCvShareComment(database, { shareId: share.id, userId: owner, anchor: "profile", authorName: "Sam", body: note })
    : undefined;
  return { share, comment };
}
const ids = async () => (await rows()).map((row) => [row.id, Boolean(row.archivedAt)]);

it("keeps a revision under review through later publishes, and lets it go once the review is done", async () => {
  const reviewed = await draft(1, { status: "generating" });
  await finish(reviewed.id);
  const { share, comment } = await shareOf(reviewed.id, user.id, "The profile buries the operations work.");
  // Two edits later the rolling archive would have deleted it, and its link and note with it.
  const second = await draft(2, { status: "generating" });
  await finish(second.id);
  const third = await draft(3, { status: "generating" });
  await finish(third.id);
  expect(await ids()).toEqual([[reviewed.id, true], [second.id, true], [third.id, false]]);
  expect(await database.select().from(schema.cvShares)).toHaveLength(1);
  expect(await database.select().from(schema.cvShareComments)).toHaveLength(1);

  // The note is dealt with, but the link is still open: someone may still be reading it.
  await resolveCvShareComment(database, user.id, comment!.id);
  const fourth = await draft(4, { status: "generating" });
  await finish(fourth.id);
  expect((await ids()).map(([id]) => id)).toContain(reviewed.id);

  // With the link ended too, the next publish takes the revision as it takes any other.
  await revokeCvShare(database, user.id, share.id);
  const fifth = await draft(5, { status: "generating" });
  await finish(fifth.id);
  expect(await ids()).toEqual([[fourth.id, true], [fifth.id, false]]);
  expect(await database.select().from(schema.cvShares)).toEqual([]);
});

it("keeps a failed revision with an open note when the next attempt is allocated, and only for its owner", async () => {
  const noted = await draft(1, { status: "failed" });
  await shareOf(noted.id, user.id, "Name the team size.");
  const plain = await draft(2, { status: "failed" });
  const newest = await draft(3, { status: "failed" });
  // Another account's link onto this draft is not this account's review, and spares nothing.
  const stranger = await ensureTestUser(database, "stranger@example.com", "member");
  await shareOf(plain.id, stranger.id, "Not the owner's reader.");
  await allocate();
  expect((await rows()).map((row) => row.id)).toEqual([noted.id, newest.id]);
});

it("still deletes a revision under review when its owner deletes it", async () => {
  const reviewed = await draft(1, { status: "ready" });
  await shareOf(reviewed.id, user.id, "A note.");
  await actionCvs(database, user.id, [reviewed.id], "delete");
  expect(await rows()).toEqual([]);
  expect(await database.select().from(schema.cvShareComments)).toEqual([]);
});

it("refuses to delete a build that starts while the delete waits for its locks", async () => {
  const queued = await draft(1, { status: "queued" });
  // A worker claims the build and moves it to generating in a transaction of its own.
  const worker = await pool.connect();
  try {
    await worker.query("begin");
    await worker.query("update cv_drafts set status = 'generating' where id = $1", [queued.id]);
    const deleting = actionCvs(database, user.id, [queued.id], "delete").then(() => "deleted", (error) => error);
    // Wait until the delete is queued behind the worker's row lock, then let the worker commit.
    for (;;) {
      const waiting = await database.execute(
        sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' limit 1`,
      );
      if (waiting.rows.length) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    await worker.query("commit");
    expect(await deleting).toBeInstanceOf(CvBuildInFlightError);
  } finally {
    worker.release();
  }
  expect((await rows()).map((row) => [row.id, row.status])).toEqual([[queued.id, "generating"]]);
});
