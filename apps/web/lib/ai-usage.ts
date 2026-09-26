/**
 * Model usage for the operations report, folded into the lines a person reads.
 *
 * The database groups `ai_calls` by account, call site and model. Several call sites can carry one
 * product feature (discovery is A1 and A2), so the rows are folded again by the label rather than
 * by the code, and the report is ordered by what each line cost. Pure: the rows come from
 * `aiUsageByAccount`, nothing here reads the database.
 */
import { aiFeatureLabel } from "@ava/core";
import type { AiAccountUsage } from "@ava/db";

export interface AiUsageGroup {
  /** Stable row key: the account, feature and model this line is for. */
  key: string;
  /** null for shared work with no account behind it. */
  userId: string | null;
  feature: string;
  model: string;
  calls: number;
  /** Split by `aiOutcome`: only `failed` is the model letting us down. */
  failed: number;
  cancelled: number;
  stalled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /**
   * Latency percentiles over every call in the folded line, from `aiUsagePercentiles` — the
   * database's `percentile_cont` over the union of the call sites, because a percentile cannot be
   * added up. Only a line the percentile read did not cover falls back to the calls-weighted mean,
   * which is labelled as such nowhere because it should not happen.
   */
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  cacheHitRatio: number | null;
}

export type AiUsageTotals = Omit<AiUsageGroup, "key" | "userId" | "feature" | "model" | "p50DurationMs" | "p95DurationMs" | "cacheHitRatio">;

const EMPTY: AiUsageTotals = { calls: 0, failed: 0, cancelled: 0, stalled: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

function add(into: AiUsageTotals, row: AiUsageTotals): void {
  into.calls += row.calls;
  into.failed += row.failed;
  into.cancelled += row.cancelled;
  into.stalled += row.stalled;
  into.inputTokens += row.inputTokens;
  into.outputTokens += row.outputTokens;
  into.cacheReadTokens += row.cacheReadTokens;
  into.cacheWriteTokens += row.cacheWriteTokens;
  into.costUsd += row.costUsd;
}

/** Calls-weighted mean of a per-row figure, ignoring rows that have none. */
function weightedMean(parts: ReadonlyArray<{ value: number | null; calls: number }>): number | null {
  let weight = 0;
  let total = 0;
  for (const part of parts) {
    if (part.value === null || part.calls <= 0) continue;
    weight += part.calls;
    total += part.value * part.calls;
  }
  return weight ? total / weight : null;
}

/** True percentiles per folded line, keyed by `aiUsageKey`. */
export type AiUsagePercentiles = ReadonlyMap<string, { p50DurationMs: number | null; p95DurationMs: number | null }>;

/** The folded line's key: account, feature and model. \u0000 cannot appear in any of them. */
export function aiUsageKey(userId: string | null, feature: string, model: string): string {
  return `${userId ?? ""}\u0000${feature}\u0000${model}`;
}

/** One line per account, feature and model, dearest first. */
export function groupAiUsage(rows: readonly AiAccountUsage[], percentiles?: AiUsagePercentiles): AiUsageGroup[] {
  const groups = new Map<string, AiUsageGroup>();
  const members = new Map<string, AiAccountUsage[]>();
  for (const row of rows) {
    const feature = aiFeatureLabel(row.callSite);
    // \u0000 cannot appear in an id, a label or a model name, so the parts cannot run together.
    const key = aiUsageKey(row.userId, feature, row.model);
    let group = groups.get(key);
    if (!group) {
      group = { key, userId: row.userId, feature, model: row.model, ...EMPTY, p50DurationMs: null, p95DurationMs: null, cacheHitRatio: null };
      groups.set(key, group);
      members.set(key, []);
    }
    members.get(key)!.push(row);
    add(group, row);
  }
  for (const [key, group] of groups) {
    const rowsInGroup = members.get(key) ?? [];
    const exact = percentiles?.get(key);
    group.p50DurationMs = exact ? exact.p50DurationMs : weightedMean(rowsInGroup.map((row) => ({ value: row.p50DurationMs, calls: row.calls })));
    group.p95DurationMs = exact ? exact.p95DurationMs : weightedMean(rowsInGroup.map((row) => ({ value: row.p95DurationMs, calls: row.calls })));
    const promptTokens = group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens;
    group.cacheHitRatio = promptTokens ? group.cacheReadTokens / promptTokens : null;
  }
  return [...groups.values()].sort(
    (a, b) => b.costUsd - a.costUsd || a.feature.localeCompare(b.feature) || a.model.localeCompare(b.model),
  );
}

/** The report's totals row. */
export function totalAiUsage(groups: readonly AiUsageGroup[]): AiUsageTotals {
  const totals = { ...EMPTY };
  for (const group of groups) add(totals, group);
  return totals;
}
