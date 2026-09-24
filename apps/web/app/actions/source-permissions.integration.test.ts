/**
 * Who may change a shared career source, against the database.
 *
 * A source is catalogue: switching one off, back on or replacing it changes what every follower is
 * scanned from, so it is an administrator's. The one thing any verified follower may do is finish a
 * discovery for a company nothing is scanned from yet — confirm the candidate, or the source that is
 * waiting for confirmation. An archived follow starts no shared work at all.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, subscribeToCompany, type Db } from "@ava/db";
import { createTestDb } from "@/test/db";
import { runMigrations } from "@ava/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { signInTestUser } from "@/test/auth";
import type { User } from "@ava/db/schema";

let database: Db;
let pool: ReturnType<typeof createDb>["pool"];
let session: string | undefined;
let admin: { user: User; cookie: string };
let member: { user: User; cookie: string };
vi.mock("@/lib/db", () => ({ db: () => database }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));

import { disableSource, enableSource, importPosting, markSourceConfirmed, pasteDiscoveryUrl, rediscoverCompany, useDiscoveryCandidate } from "./companies";
import { keepCurrentSource } from "./health";

const CANDIDATES = [
  { spec: { type: "greenhouse", url: "https://boards.greenhouse.io/acme", atsSlug: "acme" }, confidence: 0.98, method: "ats_guess" },
];

beforeAll(async () => {
  const client = createTestDb();
  database = client.db;
  pool = client.pool;
  await runMigrations(database);
  process.env.SESSION_SECRET = "integration-test-secret";
}, 120_000);
afterAll(async () => { await pool?.end(); });
beforeEach(async () => {
  await database.execute(sql`truncate companies, tasks, ai_calls, user_settings, users restart identity cascade`);
  admin = await signInTestUser(database, process.env.SESSION_SECRET!, "catalogue-admin@example.com", "admin");
  member = await signInTestUser(database, process.env.SESSION_SECRET!, "follower@example.com", "member");
  session = member.cookie;
});

type Status = "active" | "failing" | "blocked" | "needs_confirmation" | "disabled";

/** A company both accounts follow, with the sources and discovery run the case needs. */
async function fixture(options: { sources?: Array<{ status: Status; type?: "lever" | "greenhouse"; atsSlug?: string }>; candidates?: unknown[] } = {}) {
  const [company] = await database.insert(schema.companies)
    .values({ name: "Acme", domain: "acme.example", homepageUrl: "https://acme.example" }).returning();
  await subscribeToCompany(database, admin.user.id, company!.id);
  await subscribeToCompany(database, member.user.id, company!.id);
  const sources = [];
  for (const [index, source] of (options.sources ?? []).entries()) {
    const type = source.type ?? "lever";
    const [row] = await database.insert(schema.careerSources).values({
      companyId: company!.id, type, status: source.status, consecutiveFailures: source.status === "failing" ? 4 : 0,
      url: type === "greenhouse" ? `https://boards.greenhouse.io/${source.atsSlug ?? "acme"}` : `https://jobs.lever.co/acme-${index}`,
      atsSlug: source.atsSlug ?? null,
    }).returning();
    sources.push(row!);
  }
  const [run] = options.candidates
    ? await database.insert(schema.discoveryRuns).values({ companyId: company!.id, status: "needs_confirmation", candidates: options.candidates }).returning()
    : [];
  return { company: company!, sources, run };
}

const statusOf = async (sourceId: string) =>
  (await database.select({ status: schema.careerSources.status }).from(schema.careerSources).where(eq(schema.careerSources.id, sourceId)))[0]?.status;
const sourcesOf = (companyId: string) => database.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, companyId));

it("keeps disabling and re-enabling a shared source for administrators, whatever its status", async () => {
  const { sources: [active, failing, disabled] } = await fixture({ sources: [{ status: "active" }, { status: "failing" }, { status: "disabled" }] });

  await expect(disableSource(active!.id)).rejects.toThrow("Forbidden");
  await expect(disableSource(failing!.id)).rejects.toThrow("Forbidden");
  await expect(enableSource(disabled!.id)).rejects.toThrow("Forbidden");
  expect([await statusOf(active!.id), await statusOf(failing!.id), await statusOf(disabled!.id)]).toEqual(["active", "failing", "disabled"]);

  session = admin.cookie;
  await disableSource(active!.id);
  await enableSource(disabled!.id);
  expect(await statusOf(active!.id)).toBe("disabled");
  const [enabled] = await database.select().from(schema.careerSources).where(eq(schema.careerSources.id, disabled!.id));
  expect(enabled).toMatchObject({ status: "active", consecutiveFailures: 0 });
});

it("lets a follower confirm the source a company is waiting on, and nothing else", async () => {
  const waiting = await fixture({ sources: [{ status: "needs_confirmation" }] });
  await markSourceConfirmed(waiting.sources[0]!.id);
  expect(await statusOf(waiting.sources[0]!.id)).toBe("active");

  await database.execute(sql`truncate companies cascade`);
  // A second candidate beside a source every follower is already scanned from is a replacement.
  const beside = await fixture({ sources: [{ status: "active" }, { status: "needs_confirmation" }] });
  await expect(markSourceConfirmed(beside.sources[1]!.id)).rejects.toThrow("only an administrator can replace it");
  expect(await statusOf(beside.sources[1]!.id)).toBe("needs_confirmation");
  session = admin.cookie;
  await markSourceConfirmed(beside.sources[1]!.id);
  expect(await statusOf(beside.sources[1]!.id)).toBe("active");

  // Confirming is not a way to switch a disabled or blocked source back on.
  session = member.cookie;
  await database.execute(sql`truncate companies cascade`);
  const off = await fixture({ sources: [{ status: "disabled" }, { status: "blocked" }] });
  await expect(markSourceConfirmed(off.sources[0]!.id)).rejects.toThrow("only an administrator");
  await expect(markSourceConfirmed(off.sources[1]!.id)).rejects.toThrow("only an administrator");
  expect([await statusOf(off.sources[0]!.id), await statusOf(off.sources[1]!.id)]).toEqual(["disabled", "blocked"]);
});

it("lets a follower finish a discovery, but not replace a working source with a proposal", async () => {
  const fresh = await fixture({ candidates: CANDIDATES });
  await useDiscoveryCandidate(fresh.run!.id, 0);
  expect((await sourcesOf(fresh.company.id)).map(source => source.status)).toEqual(["active"]);

  await database.execute(sql`truncate companies, tasks cascade`);
  const proposal = await fixture({ sources: [{ status: "active" }], candidates: CANDIDATES });
  await expect(useDiscoveryCandidate(proposal.run!.id, 0)).rejects.toThrow("only an administrator can replace it");
  expect(await sourcesOf(proposal.company.id)).toHaveLength(1);
  const [run] = await database.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, proposal.run!.id));
  expect(run!.status).toBe("needs_confirmation");
  expect(await database.select().from(schema.tasks)).toEqual([]);
  // Declining the proposal is still every follower's to do: it changes nothing that is scanned.
  await keepCurrentSource(proposal.run!.id);
  const [declined] = await database.select().from(schema.discoveryRuns).where(eq(schema.discoveryRuns.id, proposal.run!.id));
  expect(declined).toMatchObject({ status: "resolved", chosenSourceId: proposal.sources[0]!.id });

  // Nor bring back, by way of a candidate, a board that was switched off for everyone.
  await database.execute(sql`truncate companies, tasks cascade`);
  const retired = await fixture({ sources: [{ status: "disabled", type: "greenhouse", atsSlug: "acme" }], candidates: CANDIDATES });
  await expect(useDiscoveryCandidate(retired.run!.id, 0)).rejects.toThrow("only an administrator can turn it back on");
  expect(await statusOf(retired.sources[0]!.id)).toBe("disabled");

  session = admin.cookie;
  await useDiscoveryCandidate(retired.run!.id, 0);
  expect(await statusOf(retired.sources[0]!.id)).toBe("active");
});

it("refuses shared work from an archived follow, and the source-confirming work from an unconfirmed address", async () => {
  const { company, sources: [waiting], run } = await fixture({ sources: [{ status: "needs_confirmation" }], candidates: CANDIDATES });
  await database.update(schema.companySubscriptions).set({ status: "archived" })
    .where(and(eq(schema.companySubscriptions.userId, member.user.id), eq(schema.companySubscriptions.companyId, company.id)));
  const form = new FormData();
  form.set("url", "https://acme.example/careers/role");
  await expect(pasteDiscoveryUrl(company.id, form)).rejects.toThrow("Resume following this company first.");
  await expect(rediscoverCompany(company.id)).rejects.toThrow("Resume following this company first.");
  await expect(importPosting(company.id, form)).rejects.toThrow("Resume following this company first.");
  await expect(markSourceConfirmed(waiting!.id)).rejects.toThrow("Resume following this company first.");
  await expect(useDiscoveryCandidate(run!.id, 0)).rejects.toThrow("Resume following this company first.");
  await expect(keepCurrentSource(run!.id)).rejects.toThrow("Resume following this company first.");
  expect(await database.select().from(schema.tasks)).toEqual([]);
  expect(await statusOf(waiting!.id)).toBe("needs_confirmation");

  await database.update(schema.companySubscriptions).set({ status: "active" }).where(eq(schema.companySubscriptions.userId, member.user.id));
  await database.update(schema.users).set({ emailVerifiedAt: null }).where(eq(schema.users.id, member.user.id));
  await expect(markSourceConfirmed(waiting!.id)).rejects.toThrow("redirect:/account?verify=required");
  expect(await statusOf(waiting!.id)).toBe("needs_confirmation");
});
