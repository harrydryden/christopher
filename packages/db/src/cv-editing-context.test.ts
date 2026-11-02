import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { CvContentSchema, CvLibrarySchema } from "@col/core";
import { cvAutoInputKey, cvEditingTargetsFor, type CvAutoInputV1 } from "@col/core/cv-editing-modes";
import { createDb } from "./client";
import { runMigrations } from "./migrate";
import { attachCvAutoBaselineDraft, claimCvAutoBaseline, publishCvAutoBaseline, resolveCvApplicationContext, updateCvContextDescription } from "./cv-editing-context";
import { cvAutoBaselines, cvDrafts, users } from "./schema";

const { db, pool } = createDb(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/col_test", { max: 3 });
beforeAll(() => runMigrations(db));
afterAll(() => pool.end());

const library = CvLibrarySchema.parse({ name: "Ada", contact: "London", profile: "Operations leader", entries: [
  { id: "role", kind: "experience", heading: "Operations", details: "Reduced delays by 20%", confirmedResponsibilities: ["Reduced delays by 20%"] },
] });
const content = CvContentSchema.parse({ name: "Ada", contact: "London", summary: "Operations leader", gaps: [], sections: [
  { entryId: "role", kind: "experience", heading: "Operations", bullets: ["Reduced delays by 20%"] },
] });

describe("application contexts and immutable Auto claims", () => {
  it("reopens one context, versions changed role text, deduplicates a claim and fences stale publication", async () => {
    const userId = randomUUID();
    await db.insert(users).values({ id: userId, email: `cv-edit-${userId}@example.com`, claimedAt: new Date() });
    try {
      const requestKey = `paste:${randomUUID()}`;
      const description = "Lead operational delivery and improve customer outcomes across a complex service.";
      const first = await db.transaction(tx => resolveCvApplicationContext(tx, { userId, requestKey,
        companyName: "Acme", jobTitle: "Operations Lead", description }));
      const again = await db.transaction(tx => resolveCvApplicationContext(tx, { userId, requestKey,
        companyName: "Acme", jobTitle: "Operations Lead", description }));
      expect(again.context.id).toBe(first.context.id);
      expect(again.description.id).toBe(first.description.id);
      await expect(db.transaction(tx => resolveCvApplicationContext(tx, { userId, requestKey,
        companyName: "Acme", jobTitle: "Operations Lead", description: `${description} Manage a team.` })))
        .rejects.toThrow("differs");
      const changed = { description: await db.transaction(tx => updateCvContextDescription(tx, { userId,
        contextId: first.context.id, expectedDescriptionVersionId: first.description.id,
        description: `${description} Manage a team.` })) };
      expect(changed.description.version).toBe(2);
      await expect(db.transaction(tx => updateCvContextDescription(tx, { userId,
        contextId: first.context.id, expectedDescriptionVersionId: first.description.id,
        description: `${description} Another stale tab.` }))).rejects.toThrow("changed");
      const snapshot: CvAutoInputV1 = { version: 1, contextId: first.context.id,
        descriptionVersionId: changed.description.id, jobTitle: "Operations Lead", companyName: "Acme",
        description: changed.description.text, library, basePriorityIdentity: "source-default",
        appearance: library.theme, writingPreferences: {}, routes: {},
        contracts: { promptSet: "p1", review: "r1", fit: "f1", render: "v1" } };
      const claimInput = { userId, contextId: first.context.id, descriptionVersionId: changed.description.id,
        inputKey: cvAutoInputKey(snapshot), inputSnapshot: snapshot,
        engineContract: { ...snapshot.contracts, routes: snapshot.routes } };
      const [one, two] = await Promise.all([
        db.transaction(tx => claimCvAutoBaseline(tx, claimInput)),
        db.transaction(tx => claimCvAutoBaseline(tx, claimInput)),
      ]);
      expect([one.created, two.created].sort()).toEqual([false, true]);
      expect(one.baseline.id).toBe(two.baseline.id);
      expect(one.hit || two.hit).toBe(false);
      const draftId = randomUUID();
      await db.insert(cvDrafts).values({ id: draftId, userId, contextId: first.context.id,
        descriptionVersionId: changed.description.id, editingMode: "auto", autoBaselineId: one.baseline.id,
        jobTitle: "Operations Lead", companyName: "Acme", jobDescription: changed.description.text,
        libraryVersion: 1, librarySnapshot: library, model: "model-a", status: "generating" });
      await db.transaction(tx => attachCvAutoBaselineDraft(tx, { userId, baselineId: one.baseline.id, draftId }));
      await expect(db.transaction(tx => publishCvAutoBaseline(tx, { userId, baselineId: one.baseline.id,
        sourceDraftId: randomUUID(), content, librarySnapshot: library, editingTargets: cvEditingTargetsFor(content, randomUUID) })))
        .rejects.toThrow("newer Auto build");
      const targets = cvEditingTargetsFor(content, randomUUID);
      const ready = await db.transaction(tx => publishCvAutoBaseline(tx, { userId, baselineId: one.baseline.id,
        sourceDraftId: draftId, content, librarySnapshot: library, editingTargets: targets }));
      expect(ready.status).toBe("ready");
      const hit = await db.transaction(tx => claimCvAutoBaseline(tx, claimInput));
      expect(hit.hit).toBe(true);
      expect(hit.baseline.content).toEqual(content);
      expect(await db.select().from(cvAutoBaselines).where(and(eq(cvAutoBaselines.userId, userId), eq(cvAutoBaselines.contextId, first.context.id))))
        .toHaveLength(1);
    } finally {
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
