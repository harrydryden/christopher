import { withResourceLease } from "../lease";
import { schema, enqueueTask, noteLogoFailure, storeCompanyLogo, type Db, type Task } from "@christopher/db";
import { captureCompanyLogo, dedupeKeyFor, discovery, LogoCaptureError, priorityFor, type TaskPayloads, type DiscoveryCandidate, type DiscoveryResult } from "@christopher/core";
import { and, eq, ne } from "drizzle-orm";
import { makeFetchContext, makeDiscoveryContext, type WorkerDeps } from "../context";
import { log } from "../log";

const AUTO_ACCEPT = 0.85;

export async function handleDiscover(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as TaskPayloads["discover"];
  return withResourceLease(deps, `discover:${payload.companyId}:${payload.logoOnly ? "logo" : "careers"}`, locked => discoverCompany(task, locked));
}

async function discoverCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const payload = task.payload as TaskPayloads["discover"];
  const companies = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, payload.companyId)).limit(1);
  const company = companies[0];
  if (!company) return { skipped: "company not found" };

  if (payload.logoOnly) {
    if (payload.homepageUrl !== company.homepageUrl) return { skipped: "homepage changed" };
    return captureLogo(company, deps);
  }
  // A direct ATS result must not skip branding. The separate task keeps image failures out of scans.
  const logoPayload = { companyId: company.id, logoOnly: true, homepageUrl: company.homepageUrl };
  await enqueueTask(deps.db, "discover", logoPayload, {
    dedupeKey: dedupeKeyFor("discover", logoPayload), priority: 6,
  });

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

  return deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as Db);
  // Replace a placeholder name (the raw domain or its label) with the first real one we learn,
  // from the homepage title or the verified careers feed. A name the site gave us is kept.
  const patch: Partial<typeof schema.companies.$inferInsert> = {};
  if (result.companyName && discovery.isPlaceholderName(company.name, company.domain)) patch.name = result.companyName;
  if (Object.keys(patch).length > 0) await tx.update(schema.companies).set(patch).where(eq(schema.companies.id, company.id));

  const candidates = result.candidates.map(serialiseCandidate);
  let chosenSourceId: string | null = null;
  let status: "resolved" | "needs_confirmation" | "not_found" = result.outcome;

  if (result.best && result.best.confidence >= AUTO_ACCEPT) {
    const existing = await tx.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, company.id));
    const best = result.best;
    const same = existing.find((source) => source.type === best.spec.type &&
      (best.spec.atsSlug ? source.atsSlug === best.spec.atsSlug && source.atsSite === (best.spec.atsSite ?? null) : source.url === best.spec.url));
    if (existing.length > 0 && !same) {
      status = "needs_confirmation";
    } else {
      chosenSourceId = await upsertSource(tx as unknown as Db, company.id, best, same?.confirmedByUser ?? false);
      status = "resolved";
      await enqueueTask(tx, "scan_company", { companyId: company.id, trigger: "manual" }, {
        dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }), priority: priorityFor("scan_company"),
      });
    }
  }

  await tx
    .update(schema.discoveryRuns)
    .set({ status, finishedAt: deps.now(), candidates, chosenSourceId, log: result.log })
    .where(eq(schema.discoveryRuns.id, run.id));

  log.info("discovery finished", { company: company.name, outcome: status, fetches: result.fetches, best: result.best?.method });
  return { outcome: status, candidates: candidates.length, fetches: result.fetches, sourceId: chosenSourceId };
  });
}

/**
 * Read this company's logo and store the bytes.
 *
 * Every outcome finishes the task `done`, a failure included: the retry policy for a logo is the
 * backoff written beside the company (an hour, six, a day, …), not the queue's three attempts.
 * Failing the task would ask again within minutes and give up for good by teatime, which for a
 * site that is merely down for the afternoon is exactly backwards.
 */
async function captureLogo(company: typeof schema.companies.$inferSelect, deps: WorkerDeps): Promise<unknown> {
  /**
   * Apply a write only while the homepage is still the one this capture was made from: an
   * administrator can correct a company's URL while its icon is in flight, and the bytes of the
   * old site must not land on the new one.
   */
  const ifUnchanged = async <T>(write: (tx: Db) => Promise<T>): Promise<{ applied: true; value: T } | { applied: false }> =>
    deps.db.transaction(async tx => {
      await deps.assertOwnership?.(tx as unknown as Db);
      const [current] = await tx.select({ homepageUrl: schema.companies.homepageUrl })
        .from(schema.companies).where(eq(schema.companies.id, company.id)).limit(1);
      if (!current || current.homepageUrl !== company.homepageUrl) return { applied: false };
      return { applied: true, value: await write(tx as unknown as Db) };
    });

  try {
    const logo = await captureCompanyLogo(company.homepageUrl, company.domain, makeFetchContext(deps), { previousUrl: company.faviconUrl });
    const stored = await ifUnchanged(tx => storeCompanyLogo(tx, company.id, logo, deps.now()));
    if (!stored.applied) return { skipped: "homepage changed" };
    log.info("logo captured", { company: company.name, source: logo.source, sourceUrl: logo.sourceUrl, bytes: logo.bytes.length, contentType: logo.contentType });
    return { captured: true, source: logo.source, sourceUrl: logo.sourceUrl, bytes: logo.bytes.length, contentType: logo.contentType };
  } catch (err) {
    const error = (err as Error).message;
    const tried = err instanceof LogoCaptureError ? err.tried : [];
    const noted = await ifUnchanged(tx => noteLogoFailure(tx, company.id, error, deps.now()));
    if (!noted.applied) return { skipped: "homepage changed" };
    const { attempts, nextAttemptAt } = noted.value;
    log.info("logo capture failed", { company: company.name, error, tried: tried.length, attempts, nextAttemptAt });
    return { captured: false, error, attempts, nextAttemptAt, tried: tried.length };
  }
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
