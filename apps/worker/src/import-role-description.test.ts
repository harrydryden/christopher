import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { renderCvPdf } from "@col/core/cv-pdf";
import { createDb, reevaluateGate, schema, type Db } from "@col/db";
import { runMigrations } from "@col/db/migrate";
import { eq, sql } from "drizzle-orm";
import { createDeps, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { handleImportRoleDescription } from "./handlers/import-role-description";
import { ensureTestUser, testDatabaseUrl } from "./test-users";
import { startTestServer, type TestServer } from "./test-server";

const DATABASE_URL = testDatabaseUrl("import-role-description");
const URL = "https://roles.example.test/ops-director";
const DESCRIPTION = "Lead the operations team and deliver a measured improvement to service quality. ".repeat(6);
let db: Db;
let deps: WorkerDeps;
let server: TestServer;
let userId: string;

beforeAll(async () => {
  const bootstrap = createDb(DATABASE_URL, { max: 1 });
  await runMigrations(bootstrap.db);
  await bootstrap.pool.end();
  server = await startTestServer({ "roles.example.test": {
    "/robots.txt": { body: "User-agent: *\nAllow: /", contentType: "text/plain" },
    "/ops-director": { body: `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org", "@type": "JobPosting", title: "Operations Director", url: URL,
      hiringOrganization: { "@type": "Organization", name: "Example Group" },
      description: DESCRIPTION,
    })}</script></head><body><main>${DESCRIPTION}</main></body></html>` },
    "/challenge": { body: "<html>captcha challenge</html>", headers: { "cf-mitigated": "challenge" } },
  } }, ["roles.example.test"]);
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.AVA_HOST_MAP = JSON.stringify(server.hostMap);
  process.env.AVA_DISABLE_BROWSER = "1";
  deps = await createDeps(readEnv());
  db = deps.db;
  userId = (await ensureTestUser(db, "role-import-worker@example.com")).id;
}, 60_000);
afterAll(async () => { await deps?.close(); await server?.close(); });
beforeEach(async () => { await db.execute(sql`delete from role_imports where user_id = ${userId}::uuid`); });

async function add(input: Partial<typeof schema.roleImports.$inferInsert>) {
  const [row] = await db.insert(schema.roleImports).values({
    userId, kind: "link", url: URL, fingerprint: crypto.randomUUID(), ...input,
  }).returning();
  return row!;
}
const task = (importId: string, owner = userId) => ({ type: "import_role_description", payload: { userId: owner, importId } }) as never;

it("reads a link into private, unconfirmed role text with structured employer metadata", async () => {
  const row = await add({});
  await handleImportRoleDescription(task(row.id), deps);
  const [ready] = await db.select().from(schema.roleImports).where(eq(schema.roleImports.id, row.id));
  expect(ready).toMatchObject({ status: "ready", title: "Operations Director", companyName: "Example Group", url: URL, truncated: false });
  expect(ready?.descriptionText).toContain("Lead the operations team");
  expect(await db.select().from(schema.jobs)).not.toContainEqual(expect.objectContaining({ manualOwnerId: userId }));
  await handleImportRoleDescription(task(row.id), deps);
  expect((await db.select().from(schema.roleImports).where(eq(schema.roleImports.id, row.id)))[0]?.descriptionText).toBe(ready?.descriptionText);
});

it("extracts an uploaded PDF, then clears temporary bytes", async () => {
  const pdf = await renderCvPdf({ name: "Role", contact: "London", summary: "Operations director role", sections: [{ entryId: "role", kind: "experience",
    heading: "Operations Director", bullets: [DESCRIPTION] }], gaps: [] });
  const row = await add({ kind: "pdf", url: null, filename: "role.pdf", sourceBytes: pdf.toString("base64") });
  await handleImportRoleDescription(task(row.id), deps);
  const [ready] = await db.select().from(schema.roleImports).where(eq(schema.roleImports.id, row.id));
  expect(ready?.status).toBe("ready");
  expect(ready?.sourceBytes).toBeNull();
  expect(ready?.descriptionText).toContain("Lead the operations team");
});

it("keeps an unreadable PDF for a retry or replacement", async () => {
  const sourceBytes = Buffer.from("%PDF-1.4\nnot a complete PDF").toString("base64");
  const row = await add({ kind: "pdf", url: null, filename: "role.pdf", sourceBytes });
  await handleImportRoleDescription(task(row.id), deps);
  const [failed] = await db.select().from(schema.roleImports).where(eq(schema.roleImports.id, row.id));
  expect(failed?.status).toBe("failed");
  expect(failed?.sourceBytes).toBe(sourceBytes);
  expect(failed?.error).toBeTruthy();
});

it("refuses a bot challenge and leaves a failure the person can retry", async () => {
  const row = await add({ url: "https://roles.example.test/challenge" });
  await handleImportRoleDescription(task(row.id), deps);
  const [failed] = await db.select().from(schema.roleImports).where(eq(schema.roleImports.id, row.id));
  expect(failed?.status).toBe("failed");
  expect(failed?.error).toMatch(/prevents automated reading/i);
});

it("cannot read or publish another account's import", async () => {
  const row = await add({});
  expect(await handleImportRoleDescription(task(row.id, crypto.randomUUID()), deps)).toMatchObject({ skipped: "import no longer queued" });
  expect((await db.select().from(schema.roleImports).where(eq(schema.roleImports.id, row.id)))[0]?.status).toBe("queued");
});

it("keeps a manual role in its owner's gate without exposing it to another account", async () => {
  const fingerprint = crypto.randomUUID();
  const [job] = await db.insert(schema.jobs).values({
    externalKey: `manual:${fingerprint}`, title: "Operations Director", normalizedTitle: "operations director",
    companyLabel: "Example Group", manualOwnerId: userId, manualFingerprint: fingerprint,
    inputKind: "pdf", origin: "manual", shared: false, descriptionText: DESCRIPTION,
  }).returning();
  await db.insert(schema.userJobs).values({ userId, jobId: job!.id, inTable: true });
  const settings = await deps.userSettings(userId);
  await reevaluateGate(db, userId, settings);
  const [ownView] = await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, job!.id));
  expect(ownView).toMatchObject({ userId, inTable: true, archivedAt: null });

  const stranger = await ensureTestUser(db, `stranger-${fingerprint}@example.com`);
  await reevaluateGate(db, stranger.id, await deps.userSettings(stranger.id));
  expect(await db.select().from(schema.userJobs).where(eq(schema.userJobs.jobId, job!.id))).toHaveLength(1);
});
