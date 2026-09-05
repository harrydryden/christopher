import { schema, enqueueTask, type Db, type Task } from "@christopher/db";
import { dedupeKeyFor, discovery, extractDomain, priorityFor, type DiscoveryCandidate, type DiscoveryResult } from "@christopher/core";
import { and, eq, ne } from "drizzle-orm";
import { makeDiscoveryContext, type WorkerDeps } from "../context";
import { log } from "../log";

const AUTO_ACCEPT = 0.85;

export async function handleDiscover(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as { companyId: string; url?: string; reason?: string };
  const companies = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, payload.companyId)).limit(1);
  const company = companies[0];
  if (!company) return { skipped: "company not found" };

  const [run] = await deps.db
    .insert(schema.discoveryRuns)
    .values({ companyId: company.id, status: "running" })
    .returning({ id: schema.discoveryRuns.id });
  if (!run) throw new Error("could not create a discovery run");

  const ctx = makeDiscoveryContext(deps);
  let result: DiscoveryResult;
  try {
    result = payload.url
      ? await discovery.probeUrlAsSource(payload.url, ctx)
      : await discovery.discoverCareersSources(company.homepageUrl, ctx);
  } catch (err) {
    await deps.db
      .update(schema.discoveryRuns)
      .set({ status: "failed", finishedAt: deps.now(), error: (err as Error).message.slice(0, 1000) })
      .where(eq(schema.discoveryRuns.id, run.id));
    throw err;
  }

  // Fill in the company's display name and favicon the first time we learn them.
  const patch: Partial<typeof schema.companies.$inferInsert> = {};
  if (result.companyName && (company.name === company.domain || !company.name)) patch.name = result.companyName;
  if (result.faviconUrl && !company.faviconUrl) patch.faviconUrl = result.faviconUrl;
  if (Object.keys(patch).length > 0) await deps.db.update(schema.companies).set(patch).where(eq(schema.companies.id, company.id));

  const candidates = result.candidates.map(serialiseCandidate);
  let chosenSourceId: string | null = null;
  let status: "resolved" | "needs_confirmation" | "not_found" = result.outcome;

  if (result.best && result.best.confidence >= AUTO_ACCEPT) {
    const existing = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    const best = result.best;
    const same = existing.find((source) => source.type === best.spec.type &&
      (best.spec.atsSlug ? source.atsSlug === best.spec.atsSlug && source.atsSite === (best.spec.atsSite ?? null) : source.url === best.spec.url));
    if (existing.length > 0 && !same) {
      status = "needs_confirmation";
    } else {
      chosenSourceId = await upsertSource(deps.db, company.id, best, same?.confirmedByUser ?? false);
      status = "resolved";
      await enqueueTask(deps.db, "scan_company", { companyId: company.id, trigger: "manual" }, {
        dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: priorityFor("scan_company"),
      });
    }
  }

  await deps.db
    .update(schema.discoveryRuns)
    .set({ status, finishedAt: deps.now(), candidates, chosenSourceId, log: result.log })
    .where(eq(schema.discoveryRuns.id, run.id));

  log.info("discovery finished", { company: company.name, outcome: status, fetches: result.fetches, best: result.best?.method });
  return { outcome: status, candidates: candidates.length, fetches: result.fetches, sourceId: chosenSourceId };
}

export function serialiseCandidate(candidate: DiscoveryCandidate) {
  return {
    spec: {
      type: candidate.spec.type,
      url: candidate.spec.url,
      apiUrl: candidate.spec.apiUrl,
      atsSlug: candidate.spec.atsSlug,
      atsSite: candidate.spec.atsSite,
    },
    confidence: candidate.confidence,
    method: candidate.method,
    evidence: candidate.evidence,
    sample: candidate.sample.slice(0, 3).map((p) => ({ title: p.title, url: p.url, location: p.location })),
    count: candidate.count,
    companyName: candidate.companyName,
  };
}

/** Create or refresh the career source for a chosen candidate. Existing sources are updated in place. */
export async function upsertSource(db: Db, companyId: string, candidate: DiscoveryCandidate, confirmedByUser: boolean): Promise<string> {
  const existing = await db
    .select()
    .from(schema.careerSources)
    .where(and(eq(schema.careerSources.companyId, companyId), eq(schema.careerSources.type, candidate.spec.type)));
  const match = existing.find(
    (s) => (candidate.spec.atsSlug ? s.atsSlug === candidate.spec.atsSlug && s.atsSite === (candidate.spec.atsSite ?? null) : s.url === candidate.spec.url),
  );
  const values = {
    companyId,
    type: candidate.spec.type,
    url: candidate.spec.url,
    apiUrl: candidate.spec.apiUrl ?? null,
    atsSlug: candidate.spec.atsSlug ?? null,
    atsSite: candidate.spec.atsSite ?? null,
    discoveryMethod: candidate.method,
    confidence: candidate.confidence,
    confirmedByUser,
    status: "active" as const,
    consecutiveFailures: 0,
    verifiedAt: new Date(),
  };
  if (match) {
    await db.update(schema.careerSources).set(values).where(eq(schema.careerSources.id, match.id));
    return match.id;
  }
  const [created] = await db.insert(schema.careerSources).values(values).returning({ id: schema.careerSources.id });
  if (!created) throw new Error("could not create a career source");
  // A newly confirmed source supersedes any other source of a different type that was only guessed.
  await db
    .update(schema.careerSources)
    .set({ status: "disabled" })
    .where(
      and(
        eq(schema.careerSources.companyId, companyId),
        ne(schema.careerSources.id, created.id),
        eq(schema.careerSources.confirmedByUser, false),
        eq(schema.careerSources.discoveryMethod, "ats_guess"),
      ),
    );
  return created.id;
}
