import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  actionCvs,
  completeCv,
  createDb,
  nextCvRevision,
  schema,
  type Db,
} from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { eq, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { createSessionCookieValue } from "./session";
let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
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
  const client = createDb(process.env.TEST_DATABASE_URL!);
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "cv-retention-test-secret";
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate cv_drafts cascade`);
  session = await createSessionCookieValue(process.env.SESSION_SECRET!);
});
async function draft(
  n: number,
  extra: Partial<typeof schema.cvDrafts.$inferInsert> = {},
) {
  const [row] = await database
    .insert(schema.cvDrafts)
    .values({
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
});
it("restores by swapping the current and archived CV; manual archiving replaces the archive", async () => {
  const first = await draft(1, { status: "ready", archivedAt: new Date() });
  const second = await draft(2, { status: "ready" });
  await actionCvs(database, [first.id], "restore");
  expect((await rows()).map((row) => Boolean(row.archivedAt))).toEqual([
    false,
    true,
  ]);
  await actionCvs(database, [first.id], "archive");
  expect((await rows()).map((row) => row.id)).toEqual([first.id]);
  expect((await rows())[0]!.archivedAt).not.toBeNull();
});
it("respects archive during generation and never resurrects a deleted build", async () => {
  const current = await draft(1, { status: "ready" });
  const pending = await draft(2);
  await actionCvs(database, [pending.id], "archive");
  await finish(pending.id);
  expect(
    (await rows()).find((row) => row.id === current.id)!.archivedAt,
  ).toBeNull();
  expect(
    (await rows()).find((row) => row.id === pending.id)!.archivedAt,
  ).not.toBeNull();
  await actionCvs(database, [pending.id], "delete");
  expect(await finish(pending.id)).toBe(false);
});
it("preserves submitted PDFs and application history when retention or bulk deletion removes a CV", async () => {
  const first = await draft(1, { status: "ready", archivedAt: new Date() });
  const current = await draft(2, { status: "ready" });
  const frozen = {
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
  await actionCvs(database, [current.id, newer.id], "delete");
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
  session = await createSessionCookieValue(process.env.SESSION_SECRET!);
  expect(await manageCvs({ ok: true }, form)).toEqual({ ok: true });
  expect(await rows()).toHaveLength(0);
});
it("keeps the newest selected archive when a bulk action includes the same role twice", async () => {
  const one = await draft(1),
    two = await draft(2);
  await actionCvs(database, [one.id, two.id], "archive");
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
});

it("bulk archiving a current CV and its pending replacement leaves only the selected newest archive", async () => {
  const current = await draft(1, { status: "ready" }),
    pending = await draft(2);
  await actionCvs(database, [current.id, pending.id], "archive");
  expect((await rows()).map((row) => row.id)).toEqual([pending.id]);
  expect((await rows())[0]!.archivedAt).not.toBeNull();
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
});
