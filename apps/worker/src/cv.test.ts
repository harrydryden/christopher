import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, schema, type Task } from "@christopher/db";
import { runMigrations } from "@christopher/db/migrate";
import { AiEngine } from "@christopher/ai";
import { eq, sql } from "drizzle-orm";
import { handleGenerateCv } from "./handlers/cv";
import type { WorkerDeps } from "./context";
const client = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/christopher_test");
const library = { name: "Test Candidate", contact: "London", profile: "Operations", entries: [{ id: "one", kind: "experience" as const, heading: "Director · Acme", details: "Led a team" }] };
beforeAll(async () => { await runMigrations(client.db); });
beforeEach(async () => { vi.restoreAllMocks(); await client.db.execute(sql`truncate applications, cv_drafts, ai_calls`); });
afterAll(async () => { vi.restoreAllMocks(); await client.pool.end(); });
async function setup(apiKey: string | undefined = "fixture-key") {
  const [draft] = await client.db.insert(schema.cvDrafts).values({ jobTitle: "Operations Director", companyName: "Acme", jobDescription: "Lead a team", libraryVersion: 1, librarySnapshot: library, model: "claude-sonnet-5" }).returning();
  const deps = { db: client.db, env: { anthropicApiKey: apiKey }, settings: async () => ({ monthlyAiBudgetUsd: 100 }), now: () => new Date() } as unknown as WorkerDeps;
  return { draft: draft!, deps, task: { type: "generate_cv", payload: { draftId: draft!.id } } as unknown as Task };
}
it("generates once on duplicate delivery, preserving the saved evidence", async () => {
  const build = vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Operations leader", sections: [{ entryId: "one", bullets: ["Led a team"] }], gaps: [] });
  const { task, deps, draft } = await setup();
  await Promise.all([handleGenerateCv(task, deps), handleGenerateCv(task, deps)]);
  expect(build).toHaveBeenCalledTimes(1);
  expect(build.mock.calls[0]![0].library).toEqual(library);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("ready"); expect(saved!.content?.sections[0]?.heading).toBe("Director · Acme");
});
it("shows missing credentials as a recoverable failed draft", async () => {
  const { task, deps, draft } = await setup(); deps.env.anthropicApiKey = undefined;
  await handleGenerateCv(task, deps);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("failed"); expect(saved!.error).toContain("ANTHROPIC_API_KEY");
});
it("rejects model claims referencing invented evidence", async () => {
  vi.spyOn(AiEngine.prototype, "buildCv").mockResolvedValue({ summary: "Leader", sections: [{ entryId: "fabricated", bullets: ["Piloted aircraft"] }], gaps: [] });
  const { task, deps, draft } = await setup(); await handleGenerateCv(task, deps);
  const [saved] = await client.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  expect(saved!.status).toBe("failed"); expect(saved!.content).toBeNull();
});
