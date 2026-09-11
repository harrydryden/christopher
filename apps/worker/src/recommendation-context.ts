import { schema } from "@christopher/db";
import { desc, eq, inArray } from "drizzle-orm";
import { sha1 } from "@christopher/core";
import type { WorkerDeps } from "./context";
import { latestProfile } from "./handlers/learning";

/** Stable sector coverage plus document relevance; bounded independently of portfolio size. */
export function selectExamples<T extends { name: string; domain: string; sector?: string | null; tags?: string[] | null }>(rows: T[], text = "", limit = 40): T[] {
  const words = new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const ranked = rows.map(row => ({ row, relevance: [row.sector, ...(row.tags ?? [])].filter(Boolean)
    .flatMap(s => s!.toLowerCase().split(/\W+/)).filter(s => words.has(s)).length }))
    .sort((a, b) => b.relevance - a.relevance || a.row.domain.localeCompare(b.row.domain));
  const selected = ranked.slice(0, Math.floor(limit / 2)).map(r => r.row);
  const groups = new Map<string, T[]>();
  for (const { row } of ranked) if (!selected.includes(row)) {
    const key = row.sector ?? "Unprofiled";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  while (selected.length < limit && groups.size) for (const [key, group] of groups) {
    if (selected.length >= limit) break;
    selected.push(group.shift()!);
    if (!group.length) groups.delete(key);
  }
  return selected;
}

export async function recommendationContext(deps: WorkerDeps, text = "") {
  const [rows, profile, settings, rejected] = await Promise.all([
    deps.db.select({ name: schema.companies.name, domain: schema.companies.domain, sector: schema.companyProfiles.sector, tags: schema.companyProfiles.tags })
      .from(schema.companies).leftJoin(schema.companyProfiles, eq(schema.companyProfiles.companyId, schema.companies.id))
      .where(inArray(schema.companies.status, ["active", "paused"])),
    latestProfile(deps), deps.settings(),
    deps.db.select({ name: schema.companySuggestions.name, reason: schema.companySuggestions.rejectionReason })
      .from(schema.companySuggestions).where(eq(schema.companySuggestions.status, "rejected")).orderBy(desc(schema.companySuggestions.resolvedAt)).limit(20),
  ]);
  const sectors: Record<string, number> = {};
  for (const row of rows) sectors[row.sector ?? "Unprofiled"] = (sectors[row.sector ?? "Unprofiled"] ?? 0) + 1;
  const summary = JSON.stringify({ profileVersion: profile?.version ?? 0, profile: profile?.markdown.slice(0, 12000),
    filters: settings.gate, portfolioSize: rows.length, sectors: Object.entries(sectors).sort((a,b) => b[1]-a[1]).slice(0,30),
    recentRejections: rejected.map(r => ({ name: r.name, reason: r.reason?.slice(0, 500) })) });
  return { preferences: `Context version ${sha1(summary)}\n${summary}`, examples: selectExamples(rows, text).map(r => `${r.name} (${r.domain}) · ${r.sector ?? "unprofiled"}`) };
}
