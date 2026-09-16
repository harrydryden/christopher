import { schema, enqueueTask, type Task } from "@ava/db";
import { dedupeKeyFor, discovery, extractDomain, isImportOnlySourceError, normalizeUrl, sha1, stripHtml } from "@ava/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { aiBudgetStop, makeFetchContext, type WorkerDeps } from "../context";
import { recommendationContext } from "../recommendation-context";
import { withResourceLease } from "../lease";
import { verifyCandidate } from "./companies";

/** One level of articles, bounded so a newsletter cannot turn into an unbounded crawl. */
export function articleLinks(html: string, base: string): string[] {
  const origin = new URL(base);
  return [...new Set(discovery.harvestLinks(html, base).map(l => normalizeUrl(l.href)).filter(url => {
    const u = new URL(url);
    if ((u.hostname === "linkedin.com" || u.hostname.endsWith(".linkedin.com"))) return /\/(pulse|posts)\//.test(u.pathname);
    return u.origin === origin.origin && /\/(article|news|blog|post|p)\//i.test(u.pathname);
  }))].slice(0, 10);
}

/** Letters and digits only, lower-cased: "Hims & Hers" and "hims-and-hers" compare on "himshers" and "himsandhers". */
function squash(text: string): string {
  return text.toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]+/gu, "");
}

const LEGAL_SUFFIX_RE = /\b(?:inc|incorporated|ltd|limited|llc|plc|gmbh|ag|corp|corporation|co|company|group|holdings)\b\.?/gi;

/**
 * Whether a quoted passage is evidence for this candidate: the passage names the company (legal
 * suffixes aside), and the homepage is tied to the passage too, either named in it (the address,
 * or the domain's own label: monzo.com in "Monzo raised…") or through the company's name (the label
 * of acme.example is part of "Acme Robotics"). A quote that exists in the document but is about
 * something else, or a homepage the model paired with a genuine sentence, is not evidence.
 */
export function quoteSupportsCandidate(quote: string, name: string, homepageUrl: string): boolean {
  const passage = squash(quote);
  const company = squash(name.replace(LEGAL_SUFFIX_RE, " "));
  if (!company || !passage.includes(company)) return false;
  let host: string;
  try {
    host = new URL(homepageUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  const label = squash(extractDomain(host).split(".")[0] ?? "");
  if (quote.toLowerCase().includes(host)) return true;
  return label.length >= 3 && (passage.includes(label) || company.includes(label));
}

/** A company the account already follows, or has already been offered, is never suggested again. */
async function alreadyKnown(db: WorkerDeps["db"], userId: string, domain: string): Promise<boolean> {
  const rows = await db.execute(sql`select 1 from companies c join company_subscriptions s on s.company_id = c.id
    where c.domain = ${domain} and s.user_id = ${userId}
    union all select 1 from company_suggestions where domain = ${domain} and user_id = ${userId} limit 1`);
  return rows.rows.length > 0;
}

export async function handleMonitorSource(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { sourceId } = task.payload as { sourceId: string };
  const [source] = await deps.db.select().from(schema.discoverySources).where(eq(schema.discoverySources.id, sourceId));
  if (!source?.enabled) return { skipped: "source or suggestions disabled" };
  const settings = await deps.userSettings(source.userId);
  if (!settings.suggestionsEnabled) return { skipped: "source or suggestions disabled" };
  let stored = 0;
  const fetchErrors: string[] = [];
  try {

    if (source.kind !== "email" && source.url) {
      const ctx = makeFetchContext(deps);
      const collect = async (url: string) => {
        const response = await ctx.fetchText(url);
        if (response.status >= 400) throw new Error(`HTTP ${response.status}: ${url}`);
        if (/\/authwall|\/login|\/checkpoint/.test(new URL(response.url).pathname)) throw new Error("Sign-in required. Import the newsletter text instead.");
        const content = stripHtml(response.body).slice(0, 40000);
        if (content.length < 100) throw new Error("No readable content. Import the newsletter text instead.");
        await deps.db.insert(schema.discoveryDocuments).values({ sourceId, url: response.url, title: stripHtml(response.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? source.name).slice(0, 300),
          content, fingerprint: sha1(`${normalizeUrl(response.url)}\n${content}`),
        }).onConflictDoNothing();
        return response;
      };
      try {
        const page = await collect(source.url);
        for (const url of articleLinks(page.body, page.url)) {
          try { await collect(url); } catch (error) { fetchErrors.push((error as Error).message); }
        }
      } catch (error) { fetchErrors.push((error as Error).message); }
    }
    const documents = await deps.db.select().from(schema.discoveryDocuments).where(and(
      eq(schema.discoveryDocuments.sourceId, sourceId), isNull(schema.discoveryDocuments.processedAt),
    )).orderBy(schema.discoveryDocuments.createdAt).limit(12);
    for (const document of documents) {
      await enqueueTask(deps.db, "extract_document", { sourceId, documentId: document.id }, {
        dedupeKey: dedupeKeyFor("extract_document", { sourceId, documentId: document.id }), priority: 7,
      });
    }
    const pending = await deps.db.select({ id: schema.discoveryCandidates.id }).from(schema.discoveryCandidates)
      .innerJoin(schema.discoveryDocuments, eq(schema.discoveryCandidates.documentId, schema.discoveryDocuments.id))
      .where(and(eq(schema.discoveryDocuments.sourceId, sourceId), isNull(schema.discoveryCandidates.processedAt))).limit(100);
    for (const candidate of pending) await enqueueTask(deps.db, "verify_company", { sourceId, candidateId: candidate.id }, { dedupeKey: `verify_company:${candidate.id}`, priority: 7 });
    // A site that refuses every automated reader will refuse again tomorrow. Such a source keeps
    // its normal cadence rather than retrying daily, and its imported editions still flow.
    const importOnly = fetchErrors.length > 0 && fetchErrors.every(isImportOnlySourceError);
    const retrySoon = documents.length === 12 || (fetchErrors.length > 0 && !importOnly);
    await deps.db.update(schema.discoverySources).set({ lastCheckedAt: deps.now(), lastError: fetchErrors.length ? fetchErrors.join("; ").slice(0, 1000) : null,
      nextRunAt: retrySoon ? new Date(deps.now().getTime() + 86400000) : sql`${deps.now()}::timestamptz + ${schema.discoverySources.intervalDays} * interval '1 day'`,
    }).where(eq(schema.discoverySources.id, sourceId));
    return { documents: documents.length, stored };
  } catch (error) {
    await deps.db.update(schema.discoverySources).set({ lastCheckedAt: deps.now(), lastError: (error as Error).message.slice(0, 1000),
      nextRunAt: new Date(deps.now().getTime() + 86400000),
    }).where(eq(schema.discoverySources.id, sourceId));
    throw error;
  }
}

export async function handleExtractDocument(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { sourceId, documentId } = task.payload as { sourceId: string; documentId: string };
  return withResourceLease(deps, `document:${documentId}`, async locked => {
    const [document] = await deps.db.select().from(schema.discoveryDocuments).where(eq(schema.discoveryDocuments.id, documentId));
    const [source] = await deps.db.select().from(schema.discoverySources).where(eq(schema.discoverySources.id, sourceId));
    if (!source?.enabled || !document || document.sourceId !== sourceId || document.processedAt) return { skipped: true };
    const settings = await deps.userSettings(source.userId);
    if (!settings.suggestionsEnabled) return { skipped: true };
    const userId = source.userId;
    try {
      const stop = await aiBudgetStop(deps, userId);
      // Unlike scheduled work this is a document the user asked for, so the reason is recorded on
      // their source where they can see it rather than skipped quietly.
      if (stop) throw new Error(stop === "ai unavailable" ? "AI unavailable; check again later." :
        "Your monthly AI budget is spent; raise it on Settings, or ask an administrator.");
      const context = await recommendationContext(deps, userId, document.content);
      const result = await deps.ai.extractSourceCompanies({ content: document.content, portfolio: context.examples,
        preferences: context.preferences }, { refType: "discovery_source", refId: sourceId, userId });
      if (!result) throw new Error("Company extraction failed; document retained for retry.");
      return await deps.db.transaction(async tx => {
        await locked.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
        const candidates = [];
        for (const candidate of result.candidates) {
          if (!candidate.recommended || !candidate.quote.trim() || !document.content.includes(candidate.quote)) continue;
          if (!quoteSupportsCandidate(candidate.quote, candidate.name, candidate.homepageUrl)) continue;
          let domain: string;
          try { const url = new URL(candidate.homepageUrl); if (!/^https?:$/.test(url.protocol)) continue; domain = extractDomain(url.href); } catch { continue; }
          if (await alreadyKnown(tx as unknown as WorkerDeps["db"], userId, domain)) continue;
          candidates.push({ userId, documentId, domain, name: candidate.name, homepageUrl: candidate.homepageUrl, rationale: candidate.rationale, quote: candidate.quote });
        }
        if (candidates.length) {
          const inserted = await tx.insert(schema.discoveryCandidates).values(candidates).onConflictDoNothing().returning({ id: schema.discoveryCandidates.id });
          for (const row of inserted) await enqueueTask(tx, "verify_company", { sourceId, candidateId: row.id }, { dedupeKey: `verify_company:${row.id}`, priority: 7 });
        }
        await tx.update(schema.discoveryDocuments).set({ processedAt: deps.now() }).where(eq(schema.discoveryDocuments.id, documentId));
        return { extracted: candidates.length };
      });
    } catch (error) {
      await deps.db.update(schema.discoverySources).set({ lastError: (error as Error).message.slice(0, 1000) }).where(eq(schema.discoverySources.id, sourceId));
      throw error;
    }
  });
}

export async function handleVerifyCompany(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { sourceId, candidateId } = task.payload as { sourceId?: string; candidateId: string };
  const [candidate] = await deps.db.select().from(schema.discoveryCandidates).where(eq(schema.discoveryCandidates.id, candidateId));
  const source = sourceId ? (await deps.db.select().from(schema.discoverySources).where(eq(schema.discoverySources.id, sourceId)))[0] : undefined;
  if (!candidate || candidate.processedAt || sourceId && !source?.enabled) return { skipped: true };
  const userId = candidate.userId;
  if (!(await deps.userSettings(userId)).suggestionsEnabled) return { skipped: true };
  const document = candidate.documentId ? (await deps.db.select().from(schema.discoveryDocuments).where(eq(schema.discoveryDocuments.id, candidate.documentId)))[0] : undefined;
  if (candidate.documentId && (!document || document.sourceId !== sourceId)) return { skipped: true };
  const verification = (await alreadyKnown(deps.db, userId, candidate.domain)) ? null : await verifyCandidate(deps, userId, candidate.homepageUrl, true);
  // Only a failure that says nothing final is retried. A 404, a parked or invalid homepage and a
  // company with no careers source are answers: the candidate is recorded as processed and never
  // verified again, where throwing retried it three times on every monitor cycle for ever.
  if (verification?.error && verification.transient) throw new Error(verification.error);
  const rejected = verification && !(verification.homepageOk && verification.careersSource) ? verification.error ?? "no careers source found" : undefined;
  return deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    let stored = 0;
    if (verification?.homepageOk && verification.careersSource) {
      // Recheck at commit time: the account may have started following it during verification.
      const tracked = await tx.execute(sql`select 1 from companies c join company_subscriptions s on s.company_id = c.id where c.domain = ${candidate.domain} and s.user_id = ${userId} limit 1`);
      if (!tracked.rows.length) stored = (await tx.insert(schema.companySuggestions).values({ userId, name: candidate.name, homepageUrl: candidate.homepageUrl,
        domain: candidate.domain, rationale: candidate.rationale, verification, rank: candidate.rank, similarTo: candidate.similarTo, evidence: source && document ? { sourceName: source.name,
          title: document.title, url: document.url ?? undefined, quote: candidate.quote } : null,
      }).onConflictDoNothing().returning({ id: schema.companySuggestions.id })).length;
    }
    await tx.update(schema.discoveryCandidates).set({ processedAt: deps.now() }).where(eq(schema.discoveryCandidates.id, candidateId));
    return rejected ? { stored, rejected } : { stored };
  });
}
