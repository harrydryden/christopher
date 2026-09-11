import { schema, enqueueTask, type Task } from "@christopher/db";
import { dedupeKeyFor, discovery, extractDomain, normalizeUrl, sha1, stripHtml } from "@christopher/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { aiBudgetExceeded, makeFetchContext, type WorkerDeps } from "../context";
import { latestProfile } from "./learning";
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

export async function handleMonitorSource(task: Task, deps: WorkerDeps): Promise<unknown> {
  const { sourceId } = task.payload as { sourceId: string };
  const [source] = await deps.db.select().from(schema.discoverySources).where(eq(schema.discoverySources.id, sourceId));
  const settings = await deps.settings();
  if (!source?.enabled || !settings.suggestionsEnabled) return { skipped: "source or suggestions disabled" };
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
    await deps.db.update(schema.discoverySources).set({ lastCheckedAt: deps.now(), lastError: fetchErrors.length ? fetchErrors.join("; ").slice(0, 1000) : null,
      nextRunAt: fetchErrors.length || documents.length === 12 ? new Date(deps.now().getTime() + 86400000) : sql`${deps.now()}::timestamptz + ${schema.discoverySources.intervalDays} * interval '1 day'`,
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
    const settings = await deps.settings();
    if (!source?.enabled || !settings.suggestionsEnabled || !document || document.sourceId !== sourceId || document.processedAt) return { skipped: true };
    try {
      if (await aiBudgetExceeded(deps)) throw new Error("AI unavailable or monthly budget reached; check again later.");
      const context = await recommendationContext(deps, document.content);
      const result = await deps.ai.extractSourceCompanies({ content: document.content, portfolio: context.examples,
        preferences: context.preferences }, { refType: "discovery_source", refId: sourceId });
      if (!result) throw new Error("Company extraction failed; document retained for retry.");
      return await deps.db.transaction(async tx => {
        await locked.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
        const candidates = [];
        for (const candidate of result.candidates) {
          if (!candidate.recommended || !candidate.quote.trim() || !document.content.includes(candidate.quote)) continue;
          let domain: string;
          try { const url = new URL(candidate.homepageUrl); if (!/^https?:$/.test(url.protocol)) continue; domain = extractDomain(url.href); } catch { continue; }
          const excluded = await tx.execute(sql`select domain from companies where domain = ${domain} union all select domain from company_suggestions where domain = ${domain} limit 1`);
          if (excluded.rows.length) continue;
          candidates.push({ documentId, domain, name: candidate.name, homepageUrl: candidate.homepageUrl, rationale: candidate.rationale, quote: candidate.quote });
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
  if (!candidate || candidate.processedAt || sourceId && !source?.enabled || !(await deps.settings()).suggestionsEnabled) return { skipped: true };
  const document = candidate.documentId ? (await deps.db.select().from(schema.discoveryDocuments).where(eq(schema.discoveryDocuments.id, candidate.documentId)))[0] : undefined;
  if (candidate.documentId && (!document || document.sourceId !== sourceId)) return { skipped: true };
  const excluded = await deps.db.execute(sql`select domain from companies where domain = ${candidate.domain} union all select domain from company_suggestions where domain = ${candidate.domain} limit 1`);
  const verification = excluded.rows.length ? null : await verifyCandidate(deps, candidate.homepageUrl, true);
  if (verification?.error) throw new Error(verification.error);
  return deps.db.transaction(async tx => {
    await deps.assertOwnership?.(tx as unknown as WorkerDeps["db"]);
    let stored = 0;
    if (verification?.homepageOk && verification.careersSource) {
      // Recheck the portfolio at commit time: another source/user may have added it during verification.
      const tracked = await tx.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.domain, candidate.domain));
      if (!tracked.length) stored = (await tx.insert(schema.companySuggestions).values({ name: candidate.name, homepageUrl: candidate.homepageUrl,
        domain: candidate.domain, rationale: candidate.rationale, verification, rank: candidate.rank, similarTo: candidate.similarTo, evidence: source && document ? { sourceName: source.name,
          title: document.title, url: document.url ?? undefined, quote: candidate.quote } : null,
      }).onConflictDoNothing().returning({ id: schema.companySuggestions.id })).length;
    }
    await tx.update(schema.discoveryCandidates).set({ processedAt: deps.now() }).where(eq(schema.discoveryCandidates.id, candidateId));
    return { stored };
  });
}
