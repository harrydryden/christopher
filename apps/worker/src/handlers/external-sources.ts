import { schema, type Task } from "@christopher/db";
import { discovery, extractDomain, normalizeUrl, sha1, stripHtml } from "@christopher/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { aiBudgetExceeded, makeFetchContext, type WorkerDeps } from "../context";
import { latestProfile } from "./learning";
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
  if (source.kind === "email") {
    const unread = await deps.db.select({ id: schema.discoveryDocuments.id }).from(schema.discoveryDocuments).where(and(eq(schema.discoveryDocuments.sourceId, sourceId), isNull(schema.discoveryDocuments.processedAt))).limit(1);
    if (!unread.length) {
      await deps.db.update(schema.discoverySources).set({ lastError: null, lastCheckedAt: deps.now(), nextRunAt: sql`${deps.now()}::timestamptz + ${schema.discoverySources.intervalDays} * interval '1 day'` }).where(eq(schema.discoverySources.id, sourceId));
      return { documents: 0, stored: 0 };
    }
  }
  let stored = 0;
  const fetchErrors: string[] = [];
  try {
    if (!deps.ai.enabled || await aiBudgetExceeded(deps)) throw new Error("AI unavailable or monthly budget reached; check again later.");
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
    const companies = await deps.db.select().from(schema.companies);
    const previous = await deps.db.select().from(schema.companySuggestions);
    const excluded = new Set([...companies.map(c => c.domain), ...previous.map(c => c.domain)]);
    const profile = await latestProfile(deps);
    for (const document of documents) {
      if (await aiBudgetExceeded(deps)) throw new Error("Monthly AI budget reached; remaining documents will be retried.");
      const result = await deps.ai.extractSourceCompanies({ content: document.content,
        portfolio: companies.map(c => `${c.name} (${c.domain})`),
        preferences: `${profile?.markdown ?? ""}\nRole and location filters: ${JSON.stringify(settings.gate)}`,
      }, { refType: "discovery_source", refId: sourceId });
      if (!result) throw new Error("Company extraction failed; document retained for retry.");
      for (const candidate of result.candidates) {
        if (!candidate.recommended || !candidate.quote.trim() || !document.content.includes(candidate.quote)) continue;
        let domain: string;
        try { const url = new URL(candidate.homepageUrl); if (!/^https?:$/.test(url.protocol)) continue; domain = extractDomain(url.href); } catch { continue; }
        if (excluded.has(domain)) continue;
        const verification = await verifyCandidate(deps, candidate.homepageUrl, true);
        if (!verification.homepageOk || !verification.careersSource) continue;
        const inserted = await deps.db.insert(schema.companySuggestions).values({
          name: candidate.name, homepageUrl: candidate.homepageUrl, domain, rationale: candidate.rationale,
          verification, status: "pending", evidence: { sourceName: source.name, title: document.title,
            url: document.url ?? undefined, quote: candidate.quote },
        }).onConflictDoNothing().returning({ id: schema.companySuggestions.id });
        stored += inserted.length;
        excluded.add(domain);
      }
      await deps.db.update(schema.discoveryDocuments).set({ processedAt: deps.now() }).where(eq(schema.discoveryDocuments.id, document.id));
    }
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
