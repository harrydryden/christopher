import Link from "next/link";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { HealthItems } from "@/components/HealthItems";
import { PageHeader } from "@/components/PageHeader";
import { ProblemScansCard, ScanRunsCard } from "@/components/ScanHealthCards";
import { relativeTime } from "@/lib/format";
import { workerStatusSentence } from "@/lib/worker-status";
import { countHealthItems, getWorkerStatus, healthItems, listRecentProblemScans, listRecentScanRuns } from "@/lib/queries/health";
import { needsEmailConfirmation, requireUser } from "@/lib/auth";
import { getSystemSettings } from "@/lib/settings";
import { stageRouteWarnings } from "@/lib/stage-routes";

export const dynamic = "force-dynamic";

/** The health of the companies this account follows. The whole catalogue and the queue are on Admin › Operations. */
export default async function HealthPage() {
  const user = await requireUser();
  const now = new Date();
  const [items, itemCount, problemScans, scanRuns, status, system] = await Promise.all([
    healthItems(user.id, now),
    countHealthItems(user.id, now),
    listRecentProblemScans(user.id, 7),
    listRecentScanRuns(10, user.id),
    getWorkerStatus(now),
    user.role === "admin" ? getSystemSettings() : Promise.resolve(null),
  ]);
  // A stage the administrator routed to a model or effort no committed evaluation graded: the
  // switch is theirs, but it should follow a passing replay rather than stand in for one.
  const routeWarnings = system ? stageRouteWarnings(system.stageRoutes) : [];
  // A heartbeat is rewritten on every boot, so "reported a minute ago" is true of a worker that
  // has crashed a hundred times today. When it has, say so instead.
  const trouble = workerStatusSentence(status);
  // Confirming a candidate, pasting a URL and re-discovering all spend the deployment's money, so
  // they wait for a confirmed address. Saying so here beats saying it after the click.
  const unverified = needsEmailConfirmation(user);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Health"
        actions={user.role === "admin" ? <Link prefetch={false} href="/admin/health" className="text-13 underline">Operations</Link> : undefined}
      />

      <Card title={`Needs you (${itemCount})`}>
        {items.length === 0 ? (
          <EmptyState title="Nothing needs you" description="Every company you follow is being read and your budget has room." />
        ) : (
          <div className="space-y-3">
            <HealthItems items={items} unverified={unverified} />
            {itemCount > items.length && (
              <p className="text-12 text-muted">
                Showing {items.length} of {itemCount}. The rest are on{" "}
                <Link prefetch={false} href="/companies" className="text-fg underline">Companies</Link>.
              </p>
            )}
          </div>
        )}
      </Card>

      {routeWarnings.length > 0 && (
        <Card title={`Stage routes not evaluated (${routeWarnings.length})`}>
          <div className="space-y-2">
            {routeWarnings.map((warning) => (
              <p key={warning} className="text-14 text-warn">{warning}</p>
            ))}
            <p className="text-12 text-muted">
              Change them on <Link prefetch={false} href="/admin/settings" className="text-fg underline">System settings</Link>; the procedure is in docs/DEPLOY.md, &ldquo;Changing a stage&rsquo;s effort or model&rdquo;.
            </p>
          </div>
        </Card>
      )}

      <Card title="Background worker">
        <p className="text-14">
          {trouble ?? (status.heartbeat ? `Worker reported ${relativeTime(status.heartbeat.at, now)}.` : "No worker report.")}
        </p>
      </Card>

      <ProblemScansCard title={`Recent problem scans (last 7 days, ${problemScans.length})`} rows={problemScans} now={now} companyHref={(p) => `/companies/${p.companyId}`} />

      <ScanRunsCard runs={scanRuns} now={now} companiesLabel="Your companies" emptyDescription="Daily runs appear here once the schedule starts." />
    </div>
  );
}
