/**
 * Company profiling and similar-company recommendations.
 * Every suggestion is verified deterministically before the user ever sees it (SPEC R-8.3).
 */
import { schema, enqueueTask, type Task } from "@christopher/db";
import { dedupeKeyFor, discovery, ensureHttpUrl, extractDomain, priorityFor, stripHtml, type DiscoveryResult } from "@christopher/core";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { aiBudgetExceeded, makeDiscoveryContext, makeFetchContext, type WorkerDeps } from "../context";
import { serialiseCandidate } from "./discover";
import { latestProfile } from "./learning";
import { log } from "../log";

const PARKED_MARKERS = /(domain (?:is )?for sale|buy this domain|parked (?:free )?courtesy|this domain has expired|godaddy\.com\/domain)/i;
const REJECTION_COOLDOWN_DAYS = 180;

export async function handleProfileCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { companyId } = task.payload as { companyId: string };
  const [company] = await deps.db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1);
  if (!company) return { skipped: "company not found" };
  if (!deps.ai.enabled || (await aiBudgetExceeded(deps))) return { skipped: "ai unavailable" };

  const text = await gatherCompanyText(deps, company.homepageUrl);
  if (!text) return { skipped: "no readable homepage text" };

  const profile = await deps.ai.profileCompany(
    { name: company.name, domain: company.domain, homepageText: text.homepage, aboutText: text.about },
    { refType: "company", refId: company.id },
  );
  if (!profile) return { skipped: "no ai result" };

  await deps.db
    .delete(schema.companyProfiles)
    .where(and(eq(schema.companyProfiles.companyId, company.id)));
  await deps.db.insert(schema.companyProfiles).values({
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
  const { limit } = (task.payload ?? {}) as { limit?: number };
  const settings = await deps.settings();
  if (!settings.suggestionsEnabled) return { skipped: "suggestions disabled" };
  if (!deps.ai.enabled || (await aiBudgetExceeded(deps))) return { skipped: "ai unavailable" };

  const companies = await deps.db.select().from(schema.companies).where(inArray(schema.companies.status, ["active", "paused"]));
  if (companies.length === 0) return { skipped: "no companies to compare against" };

  const profiles = await deps.db.select().from(schema.companyProfiles).where(sql`${schema.companyProfiles.companyId} is not null`);
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

  const cutoff = new Date(deps.now().getTime() - REJECTION_COOLDOWN_DAYS * 86_400_000);
  const previous = await deps.db.select().from(schema.companySuggestions);
  const excludeDomains = [
    ...companies.map((c) => c.domain),
    ...previous.filter((s) => s.status === "accepted" || (s.status === "rejected" && s.resolvedAt && s.resolvedAt > cutoff) || s.status === "pending").map((s) => s.domain),
  ];
  const rejected = previous
    .filter((s) => s.status === "rejected" && s.rejectionReason)
    .slice(0, 40)
    .map((s) => ({ name: s.name, reason: s.rejectionReason! }));

  const profile = await latestProfile(deps);
  const candidates = await deps.ai.suggestCompanies({
    portfolio,
    preferenceProfile: profile?.markdown,
    excludeDomains,
    rejected,
    limit: limit ?? 15,
  });
  if (!candidates || candidates.length === 0) return { skipped: "no candidates returned" };

  const nameToId = new Map(companies.map((c) => [c.name.toLowerCase(), c.id]));
  let stored = 0;
  let rank = 0;
  const verified: Array<{ candidate: (typeof candidates)[number]; result: VerificationResult }> = [];

  for (const candidate of candidates) {
    const result = await verifyCandidate(deps, candidate.homepageUrl, settings.gate.includeKeywords.length > 0);
    if (!result.homepageOk) {
      log.info("suggestion dropped: homepage unusable", { name: candidate.name, url: candidate.homepageUrl, error: result.error });
      continue;
    }
    if (!result.careersSource) {
      log.info("suggestion dropped: no careers source found", { name: candidate.name });
      continue;
    }
    verified.push({ candidate, result });
  }

  verified.sort((a, b) => b.candidate.confidence - a.candidate.confidence || (b.result.matchingRoles ?? 0) - (a.result.matchingRoles ?? 0));

  for (const { candidate, result } of verified.slice(0, 10)) {
    const domain = extractDomain(candidate.homepageUrl);
    const similarTo = candidate.similarTo.map((name) => nameToId.get(name.toLowerCase())).filter((id): id is string => !!id);
    const inserted = await deps.db
      .insert(schema.companySuggestions)
      .values({
        name: candidate.name,
        homepageUrl: candidate.homepageUrl,
        domain,
        rationale: candidate.rationale,
        similarTo,
        verification: {
          homepageOk: true,
          careersSource: result.careersSource,
          openRoles: result.openRoles,
          matchingRoles: result.matchingRoles,
        },
        rank: rank++,
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: schema.companySuggestions.id });
    if (inserted.length) stored++;
  }

  log.info("company suggestions", { proposed: candidates.length, verified: verified.length, stored });
  return { proposed: candidates.length, verified: verified.length, stored };
}

interface VerificationResult {
  homepageOk: boolean;
  careersSource?: { type: string; url: string; confidence: number } | null;
  openRoles?: number;
  matchingRoles?: number;
  error?: string;
}

/** A suggestion is only shown once we have confirmed the company is real and hiring. */
async function verifyCandidate(deps: WorkerDeps, homepageUrl: string, countMatching: boolean): Promise<VerificationResult> {
  let url: string;
  try {
    url = ensureHttpUrl(homepageUrl);
  } catch {
    return { homepageOk: false, error: "invalid url" };
  }
  const ctx = makeFetchContext(deps);
  try {
    const res = await ctx.fetchText(url);
    if (res.status >= 400) return { homepageOk: false, error: `HTTP ${res.status}` };
    if (PARKED_MARKERS.test(res.body.slice(0, 20_000))) return { homepageOk: false, error: "parked domain" };
  } catch (err) {
    return { homepageOk: false, error: (err as Error).message };
  }

  let result: DiscoveryResult;
  try {
    // Probe mode: a small fetch budget and no model calls, since this runs for many candidates.
    result = await discovery.discoverCareersSources(url, makeDiscoveryContext(deps, { maxFetches: 12, useAi: false }));
  } catch (err) {
    return { homepageOk: true, careersSource: null, error: (err as Error).message };
  }
  if (!result.best) return { homepageOk: true, careersSource: null };

  const settings = await deps.settings();
  const sample = result.best.sample ?? [];
  const openRoles = result.best.count ?? sample.length;
  let matchingRoles: number | undefined;
  if (countMatching && sample.length > 0) {
    const { evaluateGate } = await import("@christopher/core");
    matchingRoles = sample.filter((p) => evaluateGate({ title: p.title, location: p.location, remote: p.remote }, settings.gate).inTable).length;
  }
  return {
    homepageOk: true,
    careersSource: { type: result.best.spec.type, url: result.best.spec.url, confidence: result.best.confidence },
    openRoles,
    matchingRoles,
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
  let queued = 0;
  for (const row of rows) {
    const id = await enqueueTask(deps.db, "profile_company", { companyId: row.id }, {
      dedupeKey: dedupeKeyFor("profile_company", { companyId: row.id }),
      priority: priorityFor("profile_company"),
    });
    if (id) queued++;
  }
  return queued;
}

export { serialiseCandidate, gatherCompanyText as _gatherCompanyTextForTests };
