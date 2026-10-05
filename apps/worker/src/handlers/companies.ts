/**
 * Company profiling and similar-company recommendations.
 * Profiles are shared (one per company); recommendations are made for one account at a time from
 * the companies that account follows. Every suggestion is verified deterministically before the
 * user ever sees it (SPEC R-8.3).
 */
import { schema, taskRow, enqueueTasks, type Task } from "@col/db";
import { discovery, ensureHttpUrl, evaluateGate, extractDomain, SourceFetchError, stripHtml, type DiscoveryResult, type TaskPayloads } from "@col/core";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { aiBudgetStop, makeDiscoveryContext, makeFetchContext, type WorkerDeps } from "../context";
import { ACCOUNT_BUDGET_REFUSED, withinAccountBudget } from "../budget";
import { serialiseCandidate } from "./discover";
import { latestProfile } from "./learning";
import { withResourceLease } from "../lease";
import { selectExamples, recommendationContext, followedCompanies } from "../recommendation-context";
import { sha1 } from "@col/core";
import { log } from "../log";

const PARKED_MARKERS = /(domain (?:is )?for sale|buy this domain|parked (?:free )?courtesy|this domain has expired|godaddy\.com\/domain)/i;

export async function handleProfileCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { companyId } = task.payload as { companyId: string };
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1);
  if (!company) return { skipped: "company not found" };
  const profileStop = await aiBudgetStop(deps);
  if (profileStop) return { skipped: profileStop };

  const text = await gatherCompanyText(deps, company.homepageUrl);
  if (!text) return { skipped: "no readable homepage text" };

  const profile = await deps.ai.profileCompany(
    { name: company.name, domain: company.domain, homepageText: text.homepage, aboutText: text.about },
    { refType: "company", refId: company.id },
  );
  if (!profile) return { skipped: "no ai result" };

  await deps.db.transaction(async tx => {
  await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
  // Serialise replacement and retain the previous profile if the insert fails.
  const [current] = await tx.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, company.id)).for("update");
  if (!current) return;
  await tx
    .delete(schema.companyProfiles)
    .where(and(eq(schema.companyProfiles.companyId, company.id)));
  await tx.insert(schema.companyProfiles).values({
    companyId: company.id,
    name: company.name,
    domain: company.domain,
    oneLiner: profile.oneLiner,
    sector: profile.sector,
    subSector: profile.subSector ?? null,
    businessModel: profile.businessModel ?? null,
    customerType: profile.customerType ?? null,
    stage: profile.stage ?? null,
    sizeBand: profile.sizeBand ?? null,
    hqCountry: profile.hqCountry ?? null,
    geographies: profile.geographies ?? [],
    tags: profile.tags ?? [],
    raw: profile,
  });
  });
  return { sector: profile.sector, stage: profile.stage };
}

async function gatherCompanyText(deps: WorkerDeps, homepageUrl: string): Promise<{ homepage: string; about?: string } | null> {
  const ctx = makeFetchContext(deps);
  let homepage: string;
  let origin: string;
  try {
    const res = await ctx.fetchText(homepageUrl);
    if (res.status >= 400) return null;
    homepage = stripHtml(res.body).slice(0, 12_000);
    origin = new URL(res.url).origin;
  } catch {
    return null;
  }
  let about: string | undefined;
  for (const path of ["/about", "/about-us", "/company"]) {
    try {
      const res = await ctx.fetchText(`${origin}${path}`);
      if (res.status < 400) {
        const text = stripHtml(res.body).slice(0, 12_000);
        if (text.length > 200) {
          about = text;
          break;
        }
      }
    } catch {
      /* try the next path */
    }
  }
  return { homepage, about };
}

export async function handleSuggestCompanies(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { userId, limit } = (task.payload ?? {}) as TaskPayloads["suggest_companies"];
  if (!userId) return { skipped: "no account on task" };
  if (task.id) {
    const checkpoint = await deps.db.select({ id: schema.discoveryCandidates.id, processedAt: schema.discoveryCandidates.processedAt }).from(schema.discoveryCandidates).where(eq(schema.discoveryCandidates.batchKey, task.id));
    if (checkpoint.length) {
      await enqueueTasks(deps.db, checkpoint.filter(candidate => !candidate.processedAt).map(candidate => ({
        type: "verify_company" as const, payload: { candidateId: candidate.id }, dedupeKey: `verify_company:${candidate.id}`, priority: 7,
      })));
      return { resumed: checkpoint.length };
    }
  }
  const settings = await deps.userSettings(userId);
  if (!settings.suggestionsEnabled) return { skipped: "suggestions disabled" };
  const suggestStop = await aiBudgetStop(deps, userId);
  if (suggestStop) return { skipped: suggestStop };

  const companies = await followedCompanies(deps, userId);
  if (companies.length === 0) return { skipped: "no companies to compare against" };

  // Only the followed companies' profiles, and only the columns the portfolio shows.
  const profiles = await deps.db.select({
    companyId: schema.companyProfiles.companyId, oneLiner: schema.companyProfiles.oneLiner, sector: schema.companyProfiles.sector,
    stage: schema.companyProfiles.stage, sizeBand: schema.companyProfiles.sizeBand, hqCountry: schema.companyProfiles.hqCountry, tags: schema.companyProfiles.tags,
  }).from(schema.companyProfiles).where(inArray(schema.companyProfiles.companyId, companies.map((c) => c.id)));
  const profileByCompany = new Map(profiles.map((p) => [p.companyId!, p]));
  const portfolio = companies.map((c) => {
    const p = profileByCompany.get(c.id);
    return {
      name: c.name,
      domain: c.domain,
      oneLiner: p?.oneLiner ?? undefined,
      sector: p?.sector ?? undefined,
      stage: p?.stage ?? undefined,
      sizeBand: p?.sizeBand ?? undefined,
      hqCountry: p?.hqCountry ?? undefined,
      tags: p?.tags ?? undefined,
    };
  });

  const previous = await deps.db.select({ domain: schema.companySuggestions.domain, status: schema.companySuggestions.status, name: schema.companySuggestions.name,
    rejectionReason: schema.companySuggestions.rejectionReason, resolvedAt: schema.companySuggestions.resolvedAt }).from(schema.companySuggestions)
    .where(eq(schema.companySuggestions.userId, userId));
  const excludeDomains = [...companies.map(c => c.domain), ...previous.map(s => s.domain)];
  const rejected = previous
    .filter((s) => s.status === "rejected" && s.rejectionReason)
    .slice(0, 40)
    .map((s) => ({ name: s.name, reason: s.rejectionReason! }));

  const candidates = await withinAccountBudget(deps.ai.suggestCompanies({
    portfolio: selectExamples(portfolio),
    preferenceProfile: (await recommendationContext(deps, userId)).preferences,
    excludeDomains,
    rejected,
    limit: limit ?? 15,
  }, { refType: "suggestions", refId: userId, userId }));
  if (candidates === ACCOUNT_BUDGET_REFUSED) return { skipped: "account ai budget exceeded" };
  if (!candidates || candidates.length === 0) return { skipped: "no candidates returned" };

  const nameToId = new Map(companies.map((c) => [c.name.toLowerCase(), c.id]));
  return deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    // One insert for the batch and one enqueue for what it stored, rather than two statements per
    // candidate. A domain the batch names twice is stored once: the conflict skips the repeat.
    const values = [...candidates.entries()].flatMap(([rank, candidate]) => {
      const domain = extractDomain(candidate.homepageUrl);
      if (excludeDomains.includes(domain)) return [];
      const similarTo = candidate.similarTo.map(name => nameToId.get(name.toLowerCase())).filter((id): id is string => !!id);
      return [{ userId, name: candidate.name, domain, homepageUrl: candidate.homepageUrl,
        rationale: candidate.rationale, quote: "", similarTo, rank, batchKey: task.id ?? "manual" }];
    });
    const rows = values.length
      ? await tx.insert(schema.discoveryCandidates).values(values).onConflictDoNothing().returning({ id: schema.discoveryCandidates.id })
      : [];
    await enqueueTasks(tx, rows.map(row => ({ type: "verify_company" as const, payload: { candidateId: row.id }, dedupeKey: `verify_company:${row.id}`, priority: 7 })));
    return { proposed: candidates.length, queued: rows.length };
  });
}

interface VerificationResult {
  homepageOk: boolean;
  careersSource?: { type: string; url: string; confidence: number } | null;
  openRoles?: number;
  matchingRoles?: number;
  error?: string;
  /**
   * The failure says nothing final about the company: the host asked us to come back later, a
   * request timed out, or the careers board could not be verified for now. Only such a failure is
   * worth retrying; every other outcome, a 404 or a parked domain included, is the answer.
   */
  transient?: boolean;
}

/** What is cached for a domain: everything that holds for every account, and the sampled roles. */
interface DomainVerification extends Omit<VerificationResult, "matchingRoles"> {
  sample?: Array<{ title: string; location?: string; remote?: boolean }>;
}

/**
 * A 429 or 503 the host sent as "come back later", a plain 5xx, a timeout or a busy host. Not a
 * `blocked` verdict, whatever status it carries — a robots refusal (999) or a bot challenge served
 * as a 503 is a fact about the host, cached for the day like any other failure — and not a DNS
 * failure, which is what an invented domain does.
 */
export function transientFailure(err: unknown): boolean {
  if (err instanceof SourceFetchError)
    return err.kind === "rate_limited" || err.kind === "timeout" || (err.kind === "http" && (err.status ?? 0) >= 500);
  return err instanceof Error && err.name === "HostBusyError";
}

/**
 * A suggestion is only shown once we have confirmed the company is real and hiring. The company's
 * verification is shared by every account and cached per domain (seven days when a careers source
 * was found, one day otherwise); only the count of sampled roles that pass the account's own gate
 * is worked out per call. A transient failure is not cached.
 */
export async function verifyCandidate(deps: WorkerDeps, userId: string, homepageUrl: string, countMatching: boolean): Promise<VerificationResult> {
  const key = sha1(`domain:${extractDomain(homepageUrl)}`);
  const { sample, ...verification } = await withResourceLease(deps, `verification:${key}`, async (locked): Promise<DomainVerification> => {
    const [cached] = await deps.db.select().from(schema.verificationCache).where(eq(schema.verificationCache.key, key));
    if (cached && cached.expiresAt > deps.now()) return cached.result as DomainVerification;
    const result = await verifyUncached(deps, homepageUrl);
    if (!result.transient) await deps.db.transaction(async tx => {
      await locked.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
      const expiresAt = new Date(deps.now().getTime() + (result.careersSource ? 7 : 1) * 86400000);
      await tx.insert(schema.verificationCache).values({ key, result, expiresAt }).onConflictDoUpdate({ target: schema.verificationCache.key, set: { result, expiresAt } });
    });
    return result;
  });
  if (!countMatching || !verification.careersSource || !sample?.length) return verification;
  const { gate } = await deps.userSettings(userId);
  return { ...verification, matchingRoles: sample.filter((p) => evaluateGate({ title: p.title, location: p.location, remote: p.remote }, gate).inTable).length };
}

async function verifyUncached(deps: WorkerDeps, homepageUrl: string): Promise<DomainVerification> {
  let url: string;
  try {
    url = ensureHttpUrl(homepageUrl);
  } catch {
    return { homepageOk: false, error: "invalid url" };
  }
  const ctx = makeFetchContext(deps);
  try {
    const res = await ctx.fetchText(url);
    if (res.status >= 400) return { homepageOk: false, error: `HTTP ${res.status}`, ...(res.status === 429 || res.status >= 500 ? { transient: true } : {}) };
    if (PARKED_MARKERS.test(res.body.slice(0, 20_000))) return { homepageOk: false, error: "parked domain" };
  } catch (err) {
    return { homepageOk: false, error: (err as Error).message, ...(transientFailure(err) ? { transient: true } : {}) };
  }

  let result: DiscoveryResult;
  try {
    // Probe mode: small fetch and verification budgets and no model calls, since this runs for
    // many candidates.
    result = await discovery.discoverCareersSources(url, { ...makeDiscoveryContext(deps, { maxFetches: 12, useAi: false }), maxVerifications: 4 });
  } catch (err) {
    return { homepageOk: true, careersSource: null, error: (err as Error).message, transient: true };
  }
  // The best board could not be verified for now: not evidence that there is none.
  if (result.retry && result.outcome !== "resolved") return { homepageOk: true, careersSource: null, error: result.retry, transient: true };
  if (!result.best) return { homepageOk: true, careersSource: null };

  const sample = result.best.sample ?? [];
  return {
    homepageOk: true,
    careersSource: { type: result.best.spec.type, url: result.best.spec.url, confidence: result.best.confidence },
    openRoles: result.best.count ?? sample.length,
    sample: sample.slice(0, 3).map((p) => ({ title: p.title, location: p.location, remote: p.remote })),
  };
}

/** Queue a profile for every company that has never been profiled, and refresh stale ones. */
export async function queueMissingCompanyProfiles(deps: WorkerDeps): Promise<number> {
  const stale = new Date(deps.now().getTime() - 90 * 86_400_000);
  const rows = await deps.db
    .select({ id: schema.companies.id })
    .from(schema.companies)
    .leftJoin(schema.companyProfiles, eq(schema.companyProfiles.companyId, schema.companies.id))
    .where(and(eq(schema.companies.status, "active"), or(isNull(schema.companyProfiles.id), sql`${schema.companyProfiles.generatedAt} < ${stale}`)))
    .limit(20);
  return enqueueTasks(deps.db, rows.map(row => taskRow("profile_company", { companyId: row.id })));
}

export { serialiseCandidate, gatherCompanyText as _gatherCompanyTextForTests, latestProfile as _latestProfile };
