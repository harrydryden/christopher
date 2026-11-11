import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { createTestDb } from "@/test/db";
import { ensureTestUser } from "@/test/auth";
import { desc, eq, sql } from "drizzle-orm";
import { DEFAULT_CV_THEME, type CvLibrary } from "@col/core/cv";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let currentUserId = "";
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: currentUserId }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveCvAbout, type CvAboutValues } from "./cv-about";

const details: CvAboutValues = { name: "Taylor", email: "taylor@example.com", phone: "+44 20 0000 0000",
  location: "London", linkedinUrl: "https://www.linkedin.com/in/taylor", websiteUrl: "https://example.com",
  contact: "Available for remote work", profile: "A concise profile" };
const original: CvLibrary = { name: "Original", contact: "Old line", profile: "Old profile", entries: [{
  id: "work-1", kind: "experience", status: "active", heading: "Director · Example", details: "Led delivery",
}], stylePreferences: "Plain language", preferredWording: "Keep this phrasing", theme: DEFAULT_CV_THEME };

beforeAll(async () => { const client = createTestDb(); database = client.db; pool = client.pool;
  await runMigrations(database); }, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => { await database.execute(sql`truncate cv_libraries, users restart identity cascade`);
  const user = await ensureTestUser(database); currentUserId = user.id;
  await database.insert(schema.cvLibraries).values({ userId: user.id, version: 1, content: original }); });

async function latest() {
  const [row] = await database.select().from(schema.cvLibraries).where(eq(schema.cvLibraries.userId, currentUserId))
    .orderBy(desc(schema.cvLibraries.version)).limit(1);
  return row!;
}

it("changes only About/contact while preserving career entries, theme and writing preferences", async () => {
  expect(await saveCvAbout(1, details)).toEqual({ ok: true, version: 2 });
  const row = await latest();
  expect(row.content).toMatchObject({ ...details, theme: original.theme,
    stylePreferences: original.stylePreferences, preferredWording: original.preferredWording });
  // The compatibility projection may re-key a legacy entry when Career first backfills it;
  // its source fact and wording must remain available after this contact-only save.
  expect(row.content.entries.some(entry => entry.details.includes("Led delivery"))).toBe(true);
});

it("rejects a stale save without overwriting the newer version", async () => {
  expect((await saveCvAbout(1, details)).ok).toBe(true);
  expect(await saveCvAbout(1, { ...details, profile: "Stale profile" }))
    .toMatchObject({ ok: false, error: expect.stringContaining("changed") });
  expect((await latest()).content.profile).toBe(details.profile);
});

it("cannot write another account's Library version", async () => {
  const other = await ensureTestUser(database, "other@example.com");
  currentUserId = other.id;
  expect((await saveCvAbout(1, details)).ok).toBe(false);
  currentUserId = (await ensureTestUser(database)).id;
  expect((await latest()).content).toEqual(original);
});
