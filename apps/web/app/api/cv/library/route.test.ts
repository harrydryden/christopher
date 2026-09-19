/**
 * The stored Library, read back for the editor's "Reload and keep my text".
 *
 * It is the newest version and this account's alone: a library is never read without the account
 * that owns it, and the response is never cached, because the whole reason it is being read is
 * that the stored version has just moved on.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { sql } from "drizzle-orm";
import { ensureTestUser } from "@/test/auth";
import type { CvLibrary } from "@christopher/core/cv";
import type { User } from "@christopher/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let user: User;
let other: User;
const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("@/lib/auth", () => ({ requireUser: auth }));
import { GET } from "./route";

const library = (profile: string): CvLibrary => ({
  name: "Rowan Mercer",
  contact: "Manchester",
  profile,
  structuredExperience: true,
  employment: [],
  entries: [{ id: "ev", kind: "skill", status: "active", heading: "Tools", details: "SQL." }],
});

beforeAll(async () => {
  const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
});
afterAll(() => pool.end());
beforeEach(async () => {
  await database.execute(sql`truncate cv_libraries, users restart identity cascade`);
  user = await ensureTestUser(database, "library-route@example.com");
  other = await ensureTestUser(database, "someone-else@example.com", "member");
  auth.mockReset();
  auth.mockResolvedValue(user);
});

it("returns this account's newest library version, and never another account's", async () => {
  await database.insert(schema.cvLibraries).values([
    { userId: user.id, version: 1, content: library("First.") },
    { userId: user.id, version: 2, content: library("Second.") },
    { userId: other.id, version: 9, content: library("Not yours.") },
  ]);

  const response = await GET();
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json();
  expect(body.version).toBe(2);
  expect(body.content.profile).toBe("Second.");

  auth.mockResolvedValue(other);
  expect((await (await GET()).json()).version).toBe(9);
});

it("answers an account that has never saved a library with nothing, rather than failing", async () => {
  expect(await (await GET()).json()).toEqual({ version: 0, content: null });
});

it("reads nothing at all without an account", async () => {
  auth.mockRejectedValue(new Error("Unauthorised"));
  await expect(GET()).rejects.toThrow("Unauthorised");
});
