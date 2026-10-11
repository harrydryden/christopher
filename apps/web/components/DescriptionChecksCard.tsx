import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { careerSources, companySubscriptions, jobs, tasks } from "@col/db/schema";
import { retryDescriptionCheck } from "@/app/actions/health";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { relativeTime } from "@/lib/format";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Card } from "./Card";
import { VERIFY_SENTENCE } from "./VerifyNotice";

/** Current follower-visible roles whose missing or stale description needs another read. */
export async function DescriptionChecksCard({ companyId, unverified }: { companyId: string; unverified: boolean }) {
  const user = await requireUser();
  const rows = await db().select({ id: jobs.id, title: jobs.title, retryAttempts: jobs.descriptionRetryAttempts,
    nextAttemptAt: jobs.descriptionNextAttemptAt, error: jobs.descriptionLastError,
    hasDescription: isNotNull(jobs.descriptionText) })
    .from(jobs)
    .innerJoin(careerSources, eq(careerSources.id, jobs.sourceId))
    .innerJoin(companySubscriptions, and(eq(companySubscriptions.companyId, jobs.companyId),
      eq(companySubscriptions.userId, user.id), eq(companySubscriptions.status, "active")))
    .where(and(eq(jobs.companyId, companyId), eq(jobs.status, "open"), isNotNull(jobs.descriptionLastError),
      or(eq(jobs.shared, true), eq(jobs.addedBy, user.id)),
      or(eq(careerSources.status, "active"), eq(careerSources.status, "failing"))))
    .orderBy(sql`case when ${jobs.descriptionNextAttemptAt} is null then 0 else 1 end`, desc(jobs.descriptionAttemptedAt)).limit(20);
  if (!rows.length) return null;
  const active = await db().select({ jobId: sql<string>`${tasks.payload}->>'jobId'`, status: tasks.status })
    .from(tasks).where(and(eq(tasks.type, "fetch_description"), inArray(tasks.status, ["queued", "running"]),
      inArray(sql<string>`${tasks.payload}->>'jobId'`, rows.map(row => row.id))));
  const taskStatus = new Map(active.map(task => [task.jobId, task.status]));
  const now = new Date();
  return <Card title={`Role descriptions to check (${rows.length})`}>
    <p className="text-14 text-muted">A careers page did not provide usable description text. Saved roles and any previous description are kept; matches needing description text may wait.</p>
    <ul className="mt-3 space-y-2">
      {rows.map(row => <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-line-faint pt-2 text-13">
        <div className="min-w-0">
          <p className="font-medium">{row.title}</p>
          <p className="text-muted">{row.error}{row.hasDescription ? " Previous description kept." : ""}</p>
          <p className="text-muted">{taskStatus.get(row.id) === "running"
            ? <>Attempt {row.retryAttempts + 1} of 6 is running.</>
            : taskStatus.get(row.id) === "queued"
              ? <>Attempt {row.retryAttempts} of 6; next check {row.nextAttemptAt ? relativeTime(row.nextAttemptAt, now) : "soon"}.</>
              : <>Automatic check is {row.nextAttemptAt ? "interrupted" : "finished"} after {row.retryAttempts} attempts. You can retry.</>}</p>
        </div>
        {taskStatus.get(row.id) ? <Badge tone="blue">{taskStatus.get(row.id) === "running" ? "Checking" : "Scheduled"}</Badge>
          : <form action={retryDescriptionCheck.bind(null, row.id)}>
              <Button type="submit" size="sm" disabled={unverified} title={unverified ? VERIFY_SENTENCE : undefined}>Retry description</Button>
            </form>}
      </li>)}
    </ul>
  </Card>;
}
