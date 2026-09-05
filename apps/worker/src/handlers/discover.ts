import { schema, enqueueTask, type Task } from "@christopher/db";
import { dedupeKeyFor, discovery, priorityFor, type DiscoveryResult } from "@christopher/core";
import { and, desc, eq } from "drizzle-orm";
import type { WorkerDeps } from "../context";
import { makeDiscoveryContext } from "../context";
import { log } from "../log";

interface DiscoverPayload {
  companyId: string;
  url?: string;
  reason?: string;
}

export async function handleDiscover(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as unknown as DiscoverPayload;
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, payload.companyId)).limit(1);
  if (!company) return { skipped: "company not found" };

  const [run] = await deps.db
    .insert(schema.discoveryRuns)
    .values({ companyId: company.id, status: "running", startedAt: deps.now() })
    .returning();
  if (!run) throw new Error("failed to create discovery run");

  const ctx = makeDiscoveryContext(deps, { maxFetches: 40 });
  let result: DiscoveryResult;
  try {
    result = payload.url
      ? await discovery.probeUrlAsSource(payload.url, ctx)
      : await discovery.discoverCareersSources(company.homepageUrl, ctx);
  } catch (err) {
    await deps.db
      .update(schema.discoveryRuns)
      .set({ status: "failed", finishedAt: deps.now(), error: (err as Error).message.slice(0, 2000) })
      .where(eq(schema.discoveryRuns.id, run.id));
    throw err;
  }

  const candidates = result.candidates.map((c) => ({
    spec: c.spec,
    confidence: c.confidence,
    method: c.method,
    evidence: c.evidence,
    sample: c.sample.slice(0, 3).map((p) => ({ title: p.title, url: p.url, location: p.location })),
    count: c.count,
    companyName: c.companyName,
  }));

  // Fill in the company's display name and favicon on first successful discovery.
  const patch: Partial<typeof schema.companies.$inferInsert> = {};
  if (result.companyName && (company.name === company.domain || !company.name)) patch.name = result.companyName;
  if (result.faviconUrl && !company.faviconUrl) patch.faviconUrl = result.faviconUrl;
  if (Object.keys(patch).length) await deps.db.update(schema.companies).set(patch).where(eq(schema.companies.id, company.id));

  let chosenSourceId: string | null = null;
  const best = result.best;
  if (result.outcome === "resolved" && best) {
    chosenSourceId = await upsertSource(deps, company.id, best, payload.reason === "pasted");
  }

  await deps.db
    .update(schema.discoveryRuns)
    .set({
      status: result.outcome === "resolved" ? "resolved" : result.outcome === "needs_confirmation" ? "needs_confirmation" : "not_found",
      finishedAt: deps.now(),
      candidates,
      chosenSourceId,
      log: result.log,
    })
    .where(eq(schema.discoveryRuns.id, run.id));

  if (chosenSourceId) {
    const payloadScan = { companyId: company.id, trigger: "manual" as const };
    await enqueueTask(deps.db, "scan_company", payloadScan, { dedupeKey: dedupeKeyFor("scan_company", payloadScan), priority: priorityFor("scan_company") });
    const payloadProfile = { companyId: company.id };
    await enqueueTask(deps.db, "profile_company", payloadProfile, { dedupeKey: dedupeKeyFor("profile_company", payloadProfile), priority: priorityFor("profile_company") });
  }

  log.info("discovery finished", { company: company.domain, outcome: result.outcome, best: best?.spec.type, confidence: best?.confidence, fetches: result.fetches });
  return { outcome: result.outcome, candidates: candidates.length, fetches: result.fetches, sourceId: chosenSourceId };
}

/** Create or update the career_source for a discovery candidate, keeping one row per (company, type, slug/url). */
export async function upsertSource(
  deps: WorkerDeps,
  companyId: string,
  candidate: { spec: { type: string; url: string; apiUrl?: string; atsSlug?: string; atsSite?: string; recipe?: unknown }; confidence: number; method: string },
  confirmedByUser = false,
): Promise<string> {
  const { spec } = candidate;
  const existing = await deps.db
    .select()
    .from(schema.careerSources)
    .where(and(eq(schema.careerSources.companyId, companyId), eq(schema.careerSources.type, spec.type as never)))
    .orderBy(desc(schema.careerSources.createdAt));
  const match = existing.find((s) => (spec.atsSlug ? s.atsSlug === spec.atsSlug && (s.atsSite ?? null) === (spec.atsSite ?? null) : s.url === spec.url));
  if (match) {
    await deps.db
      .update(schema.careerSources)
      .set({
        url: spec.url,
        apiUrl: spec.apiUrl ?? null,
        confidence: candidate.confidence,
        discoveryMethod: candidate.method,
        status: "active",
        confirmedByUser: match.confirmedByUser || confirmedByUser,
        consecutiveFailures: 0,
        verifiedAt: deps.now(),
      })
      .where(eq(schema.careerSources.id, match.id));
    return match.id;
  }
  const [created] = await deps.db
    .insert(schema.careerSources)
    .values({
      companyId,
      type: spec.type as never,
      url: spec.url,
      apiUrl: spec.apiUrl ?? null,
      atsSlug: spec.atsSlug ?? null,
      atsSite: spec.atsSite ?? null,
      discoveryMethod: candidate.method,
      confidence: candidate.confidence,
      confirmedByUser,
      status: "active",
      verifiedAt: deps.now(),
      recipe: (spec.recipe as object | undefined) ?? null,
    })
    .returning({ id: schema.careerSources.id });
  if (!created) throw new Error("failed to insert career source");
  return created.id;
}
