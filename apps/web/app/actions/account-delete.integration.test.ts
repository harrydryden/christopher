/**
 * Removing an account, against the database.
 *
 * Deletion runs under one lock on the accounts so that two administrators cannot remove each other
 * at once and leave nobody who can sign in as one. What is checked here is what that lock is for:
 * a caller who stopped being a claimed administrator deletes nobody, a member is deleted with their
 * sessions, and the per-day CV version rows the account's key prefix names go with it.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let admin: User;
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { deleteUser } from "./account";
import { deleteAccount } from "@/lib/accounts";

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate cv_versions, users restart identity cascade`);
  ({ user: admin, cookie: session } = await signInTestUser(database, process.env.SESSION_SECRET!, "owner@example.com"));
  await database.update(schema.users).set({ claimedAt: new Date() }).where(eq(schema.users.id, admin.id));
});

it("deletes another administrator only while the caller is still a claimed administrator", async () => {
  const { user: other } = await signInTestUser(database, process.env.SESSION_SECRET!, "second@example.com");
  await database.update(schema.users).set({ claimedAt: new Date() }).where(eq(schema.users.id, other.id));
  await expect(deleteUser(other.id)).resolves.toBeUndefined();
  // The race the lock is for: the caller stopped being an administrator, or stopped counting as a
  // claimed one, after the action admitted them. `requireAdmin` would refuse the whole call now, so
  // the library is asked directly, as the transaction would find things.
  const { user: third } = await signInTestUser(database, process.env.SESSION_SECRET!, "third@example.com");
  await database.update(schema.users).set({ claimedAt: new Date() }).where(eq(schema.users.id, third.id));
  await database.update(schema.users).set({ role: "member" }).where(eq(schema.users.id, admin.id));
  await expect(deleteAccount(admin.id, third.id)).rejects.toThrow(/no longer an administrator/);
  await database.update(schema.users).set({ role: "admin", claimedAt: null }).where(eq(schema.users.id, admin.id));
  await expect(deleteAccount(admin.id, third.id)).rejects.toThrow(/no longer an administrator/);
  const remaining = await database.select({ email: schema.users.email }).from(schema.users);
  expect(remaining.map((row) => row.email).sort()).toEqual(["owner@example.com", "third@example.com"]);
});

it("deletes a member with their sessions and CV version rows", async () => {
  const { user: member, sessionId } = await signInTestUser(database, process.env.SESSION_SECRET!, "member@example.com", "member");
  await database.insert(schema.cvVersions).values([
    { cvId: "00000000-0000-4000-8000-000000000001", roleKey: `${member.id}:4:acmeengineer`, day: "2026-09-23", version: 1 },
    { cvId: "00000000-0000-4000-8000-000000000002", roleKey: `${admin.id}:4:acmeengineer`, day: "2026-09-23", version: 1 },
  ]);
  await deleteUser(member.id);
  const [gone] = await database.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, member.id));
  expect(gone).toBeUndefined();
  const [openSession] = await database.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.id, sessionId));
  expect(openSession).toBeUndefined();
  const keys = (await database.select({ roleKey: schema.cvVersions.roleKey }).from(schema.cvVersions)).map((row) => row.roleKey);
  expect(keys).toEqual([`${admin.id}:4:acmeengineer`]);
});

it("never lets an administrator delete themselves here", async () => {
  await expect(deleteUser(admin.id)).rejects.toThrow(/your own account/);
});
