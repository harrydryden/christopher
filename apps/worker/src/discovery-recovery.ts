import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@col/db";

/** Three spaced background checks after the first settled sourceless result. */
export const DISCOVERY_RECOVERY_DELAYS_MS = [86_400_000, 3 * 86_400_000, 7 * 86_400_000] as const;

export function discoveryRecoveryAfterFailure(attempts: number, now: Date): {
  discoveryRecoveryState: "waiting" | "manual_required";
  discoveryNextAttemptAt: Date | null;
} {
  const delay = DISCOVERY_RECOVERY_DELAYS_MS[attempts];
  return delay === undefined
    ? { discoveryRecoveryState: "manual_required", discoveryNextAttemptAt: null }
    : { discoveryRecoveryState: "waiting", discoveryNextAttemptAt: new Date(now.getTime() + delay) };
}

/** The caller holds the company row lock. Sources of any status are deliberate shared catalogue state. */
export async function settleDiscoveryRecovery(db: Db, companyId: string, options: {
  outcome: "resolved" | "needs_confirmation" | "not_found" | "failed";
  automatic: boolean;
  now: Date;
}): Promise<void> {
  const [company] = await db.select({
    status: schema.companies.status,
    attempts: schema.companies.discoveryRecoveryAttempts,
  }).from(schema.companies).where(eq(schema.companies.id, companyId)).for("update").limit(1);
  if (!company) return;
  const attempts = options.automatic ? company.attempts : 0;
  const [source] = await db.select({ id: schema.careerSources.id }).from(schema.careerSources)
    .where(eq(schema.careerSources.companyId, companyId)).limit(1);
  const [followed] = await db.execute<{ active: boolean }>(sql`select exists (
    select 1 from company_subscriptions s where s.company_id = ${companyId}::uuid and s.status = 'active') as active`).then(r => r.rows);
  const terminal = options.outcome === "resolved" || options.outcome === "needs_confirmation"
    || company.status !== "active" || !followed?.active || !!source;
  await db.update(schema.companies).set({
    discoveryRecoveryAttempts: terminal ? 0 : attempts,
    ...(terminal
      ? { discoveryRecoveryState: "idle" as const, discoveryNextAttemptAt: null }
      : discoveryRecoveryAfterFailure(attempts, options.now)),
  }).where(eq(schema.companies.id, companyId));
}

/** A final queue failure has no result transaction; arm its next spaced check once. */
export async function settleAbandonedDiscovery(db: Db, companyId: string, taskId: string, taskCreatedAt: Date, automatic: boolean, now: Date): Promise<void> {
  await db.transaction(async tx => {
    const [company] = await tx.select({ homepageUrl: schema.companies.homepageUrl, state: schema.companies.discoveryRecoveryState })
      .from(schema.companies).where(eq(schema.companies.id, companyId)).for("update").limit(1);
    // The hook may be called twice. Nor may an old attempt overwrite a newer settled cycle.
    if (!company || company.state !== "idle") return;
    const [latest] = await tx.select({ taskId: schema.discoveryRuns.taskId, homepageUrl: schema.discoveryRuns.homepageUrl,
      status: schema.discoveryRuns.status, startedAt: schema.discoveryRuns.startedAt })
      .from(schema.discoveryRuns).where(eq(schema.discoveryRuns.companyId, companyId))
      .orderBy(sql`${schema.discoveryRuns.startedAt} desc`, sql`${schema.discoveryRuns.id} desc`).limit(1);
    if (latest && latest.taskId !== taskId && latest.startedAt >= taskCreatedAt) return;
    if (latest?.taskId === taskId && latest.homepageUrl !== company.homepageUrl && !automatic) return;
    // A corrected homepage invalidates this task's result, but should not strand a still-followed,
    // sourceless company. A newer task/run or a newer waiting cycle is fenced above/below.
    if (latest?.taskId === taskId && (latest.status === "resolved" || latest.status === "needs_confirmation")) return;
    const [pending] = await tx.execute<{ exists: boolean }>(sql`select exists (
      select 1 from tasks t where t.id <> ${taskId}::uuid and t.type = 'discover'
        and t.status in ('queued', 'running') and t.payload->>'companyId' = ${companyId}
        and coalesce(t.payload->>'logoOnly', 'false') <> 'true') as exists`).then(r => r.rows);
    if (pending?.exists) return;
    await settleDiscoveryRecovery(tx as unknown as Db, companyId, { outcome: "failed", automatic, now });
  });
}
