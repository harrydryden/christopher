/**
 * Mine the latest successful scan of every active source for the role types
 * and seniority labels the gate is turning away, and file them as filter
 * suggestions the user accepts or rejects on the Learning page. Deterministic
 * and free: it reads the parsed postings kept in scan evidence (snapshot v2)
 * and never calls a model. Runs after each daily run finalises and on demand.
 */
import { schema, type Task } from "@christopher/db";
import { suggestFromScans, type ScannedTitle, type TermSuggestion } from "@christopher/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { gunzipSync } from "node:zlib";
import type { WorkerDeps } from "../context";
import { log } from "../log";

type SnapshotPosting = { title?: string; location?: string; locations?: string[] };

export async function loadScannedTitles(deps: WorkerDeps): Promise<ScannedTitle[]> {
  const sources = await deps.db
    .select({ id: schema.careerSources.id, company: schema.companies.name })
    .from(schema.careerSources)
    .innerJoin(schema.companies, eq(schema.companies.id, schema.careerSources.companyId))
    .where(and(eq(schema.companies.status, "active"), inArray(schema.careerSources.status, ["active", "failing"])));
  const titles: ScannedTitle[] = [];
  for (const source of sources) {
    const [scan] = await deps.db.select({ rawSnapshot: schema.scans.rawSnapshot }).from(schema.scans)
      .where(and(eq(schema.scans.sourceId, source.id), inArray(schema.scans.status, ["ok", "partial"]), sql`${schema.scans.rawSnapshot} is not null`))
      .orderBy(desc(schema.scans.startedAt)).limit(1);
    if (!scan?.rawSnapshot) continue;
    try {
      const snapshot = JSON.parse(gunzipSync(Buffer.from(scan.rawSnapshot, "base64"), { maxOutputLength: 32_000_000 }).toString()) as { version?: number; postings?: SnapshotPosting[] };
      if (snapshot.version !== 2 || !Array.isArray(snapshot.postings)) continue;
      for (const p of snapshot.postings) {
        if (typeof p.title === "string" && p.title.trim()) titles.push({ title: p.title.trim(), company: source.company, location: p.location, locations: p.locations });
      }
    } catch { /* An older or damaged snapshot has nothing to mine. */ }
  }
  return titles;
}

export async function handleSuggestFromScans(_task: Task, deps: WorkerDeps): Promise<unknown> {
  const settings = await deps.settings();
  const titles = await loadScannedTitles(deps);
  if (titles.length === 0) return { skipped: "no scan evidence yet" };
  const result = suggestFromScans(titles, settings.gate);

  const existing = await deps.db
    .select({ type: schema.filterSuggestions.type, value: schema.filterSuggestions.value, status: schema.filterSuggestions.status })
    .from(schema.filterSuggestions)
    .where(inArray(schema.filterSuggestions.type, ["keyword_include", "seniority_include"]));
  const taken = new Set(existing.filter((e) => e.status === "pending" || e.status === "rejected").map((e) => `${e.type}:${String((e.value as { term?: string }).term ?? "").toLowerCase()}`));

  const file = async (type: "keyword_include" | "seniority_include", s: TermSuggestion) => {
    if (taken.has(`${type}:${s.term.toLowerCase()}`)) return 0;
    const what = type === "seniority_include" ? "match your role keywords and location but not your seniority labels" : "are in your location and at your seniority but match none of your role keywords";
    await deps.db.insert(schema.filterSuggestions).values({
      type,
      value: { term: s.term, source: "scans" },
      evidence: s.examples.map((e) => ({ title: e.title, company: e.company })),
      rationale: `${s.admits} ${s.admits === 1 ? "role" : "roles"} across ${s.companies} ${s.companies === 1 ? "company" : "companies"} in the latest scans ${what}; "${s.term}" would admit them.`,
    });
    return 1;
  };
  let inserted = 0;
  for (const s of result.seniority) inserted += await file("seniority_include", s);
  for (const s of result.roleTypes) inserted += await file("keyword_include", s);
  log.info("scan suggestions filed", { titles: titles.length, unmatched: result.unmatched, inserted });
  return { titles: titles.length, unmatched: result.unmatched, inserted };
}
