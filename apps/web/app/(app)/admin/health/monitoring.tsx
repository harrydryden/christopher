import type { StatementTotals } from "@ava/db";
import { Badge } from "@/components/Badge";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { formatCount, formatPercent, relativeTime } from "@/lib/format";
import type { MonitorLevel, MonitorReading, RouteVitals } from "@/lib/queries/health";
import { formatVital, VITAL_METRICS, VITALS_SAMPLE_RATE, vitalRating } from "@/lib/web-vitals";

const RATING_TONE = { good: "", "needs-improvement": "text-warn", poor: "text-danger" } as const;

const LEVEL_TONE = { ok: "green", warn: "amber", fail: "red" } as const;
const LEVEL_LABEL = { ok: "ok", warn: "attention", fail: "failing" } as const;

/** A monitor sample older than this is shown as stale: the task that takes it has stopped. */
const MONITOR_STALE_MS = 20 * 60_000;

/**
 * The worker's five-minute monitor sample: the signals the operational check enforces from `/status`,
 * each with the level the worker graded it at and the lines it was graded against.
 */
export function MonitorCard({ sample, now }: { sample: MonitorReading | null; now: Date }) {
  if (!sample) {
    return (
      <Card title="Alert signals">
        <EmptyState title="No monitor sample yet" description="The worker samples these every five minutes once a release with the monitor task is running." />
      </Card>
    );
  }
  const stale = now.getTime() - sample.at.getTime() > MONITOR_STALE_MS;
  const worker = sample.worker;
  const rows: Array<{ key: keyof MonitorReading["levels"]; signal: string; reading: string; lines: string }> = [
    { key: "heap", signal: "Worker heap", reading: worker?.heapFraction == null ? "no fresh heartbeat" : formatPercent(worker.heapFraction), lines: "attention 75% in 2 of 3 checks, fails 85% in 2" },
    { key: "eventLoop", signal: "Event-loop delay p99", reading: worker?.eventLoopLagP99Ms == null ? "not reported" : `${formatCount(worker.eventLoopLagP99Ms)} ms`, lines: "attention 200 ms, fails 1,000 ms in 2" },
    { key: "poolWaiting", signal: "Worker pool waiting", reading: worker?.dbWaiting == null ? "not reported" : formatCount(worker.dbWaiting), lines: "attention above 0 once, fails in 2" },
    { key: "backends", signal: "Active Postgres connections", reading: sample.backends ? `${sample.backends.active} of ${sample.backends.usable} usable (${formatPercent(sample.backends.fraction)}), ${sample.backends.total} open` : "not read", lines: "attention 60%, fails 80%" },
    { key: "oldestReady", signal: "Oldest ready task", reading: sample.oldestReadySeconds == null ? "not read" : `${Math.round(sample.oldestReadySeconds / 60)} min`, lines: "attention 5 min, fails 15 min" },
    { key: "scanFailures", signal: "Today's failed scans", reading: sample.scans ? (sample.scans.failedShare === null ? "no scans yet today" : `${sample.scans.failed} of ${sample.scans.total} (${formatPercent(sample.scans.failedShare)})`) : "not read", lines: "attention 10%, fails 25% of at least 10" },
    { key: "modelRateLimited", signal: "Model calls rate-limited, last hour", reading: sample.models ? (sample.models.rateLimitedShare === null ? "no calls" : `${sample.models.rateLimited1h} of ${sample.models.calls1h} (${formatPercent(sample.models.rateLimitedShare)})`) : "not read", lines: "attention 5%, fails 20% of at least 10" },
    { key: "slowQueries", signal: "Worker slow queries, 15 min", reading: sample.slowQueriesPer15m == null ? "not enough readings" : formatCount(sample.slowQueriesPer15m), lines: "attention 20, fails 100" },
  ];
  return (
    <Card title="Alert signals" actions={stale ? <Badge tone="amber">stale</Badge> : undefined}>
      <p className={`mb-3 text-14 ${stale ? "text-warn" : "text-muted"}`}>
        Sampled by the worker {relativeTime(sample.at, now)}{stale ? ", which is longer than its five minutes: the monitor task has stopped" : ""}. The operational check reads the same figures from the worker every fifteen minutes; a failing line fails that check and notifies its owner, attention is reported without failing it.
      </p>
      <Table>
        <THead>
          <tr>
            <TH>Signal</TH>
            <TH>Reading</TH>
            <TH>Lines</TH>
            <TH className="text-right">Level</TH>
          </tr>
        </THead>
        <TBody>
          {rows.map((row) => {
            const level: MonitorLevel = sample.levels[row.key] ?? "ok";
            return (
              <TR key={row.key}>
                <TD className="whitespace-nowrap">{row.signal}</TD>
                <TD className={level === "fail" ? "text-danger" : level === "warn" ? "text-warn" : ""}>{row.reading}</TD>
                <TD className="text-muted">{row.lines}</TD>
                <TD className="text-right"><Badge tone={LEVEL_TONE[level]}>{LEVEL_LABEL[level]}</Badge></TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}

/**
 * Real-user Core Web Vitals: the p75 of each metric per route over four weeks, from the sampled,
 * identifier-free beacon. Amber is "needs improvement" and red is "poor" by Google's boundaries.
 */
export function WebVitalsCard({ routes, days }: { routes: RouteVitals[]; days: number }) {
  return (
    <Card title={`Core Web Vitals, real users (${days} days)`}>
      {routes.length === 0 ? (
        <EmptyState title="No field measurements yet" description={`One signed-in page load in ${Math.round(1 / VITALS_SAMPLE_RATE)} reports its vitals when the tab is hidden; the first ones appear here within a day of this release.`} />
      ) : (
        <>
          <p className="mb-3 text-14 text-muted">
            The 75th percentile per route, which is the figure Google&rsquo;s assessment uses: three loads in four were at least this good. Measured in real browsers on one load in {Math.round(1 / VITALS_SAMPLE_RATE)}; routes with few samples move a lot from day to day.
          </p>
          <Table>
            <THead>
              <tr>
                <TH>Route</TH>
                {VITAL_METRICS.map((metric) => <TH key={metric} className="text-right">{metric}</TH>)}
                <TH className="text-right">Loads</TH>
              </tr>
            </THead>
            <TBody>
              {routes.map((row) => (
                <TR key={row.route}>
                  <TD className="max-w-[16rem] truncate" title={row.route}><code>{row.route}</code></TD>
                  {VITAL_METRICS.map((metric) => {
                    const reading = row.metrics[metric];
                    return (
                      <TD key={metric} className={`whitespace-nowrap text-right ${reading ? RATING_TONE[vitalRating(metric, reading.p75)] : "text-muted"}`} title={reading ? `${formatCount(reading.samples)} samples` : undefined}>
                        {reading ? formatVital(metric, reading.p75) : "—"}
                      </TD>
                    );
                  })}
                  <TD className="text-right text-muted">{formatCount(row.samples)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </>
      )}
    </Card>
  );
}

/**
 * The statements that have cost the database the most execution time since its statistics were last
 * reset, from pg_stat_statements. Administrators only (the page calls `requireAdmin`); the text is
 * PostgreSQL's normalised form, where literals are `$1`, cut to 160 characters, and is written to no
 * log. The same reading as `pnpm cli pgstat`.
 */
export function StatementsCard({ totals }: { totals: StatementTotals }) {
  return (
    <Card title="Costliest statements">
      {!totals.available ? (
        <EmptyState title="No statement statistics" description={totals.reason} />
      ) : totals.rows.length === 0 ? (
        <EmptyState title="Nothing recorded yet" description="The statistics were reset recently, or this database has served no statements since the server started." />
      ) : (
        <>
          <p className="mb-3 text-14 text-muted">
            By total execution time since the statistics were last reset, from pg_stat_statements. A statement near the top that is cheap per call is one that runs on every page; the hit rate is the share of its reads served from memory.
          </p>
          <Table>
            <THead>
              <tr>
                <TH className="text-right">Calls</TH>
                <TH className="text-right">Total</TH>
                <TH className="text-right">Mean</TH>
                <TH className="text-right">Std dev</TH>
                <TH className="text-right">Hit / read blocks</TH>
                <TH className="text-right">Hit rate</TH>
                <TH>Statement</TH>
              </tr>
            </THead>
            <TBody>
              {totals.rows.map((row) => (
                <TR key={row.queryid}>
                  <TD className="text-right">{formatCount(row.calls)}</TD>
                  <TD className="whitespace-nowrap text-right">{formatCount(row.totalMs)} ms</TD>
                  <TD className="whitespace-nowrap text-right">{row.meanMs.toFixed(2)} ms</TD>
                  <TD className="whitespace-nowrap text-right text-muted">{row.stddevMs.toFixed(2)} ms</TD>
                  <TD className="whitespace-nowrap text-right text-muted">{formatCount(row.sharedBlksHit)} / {formatCount(row.sharedBlksRead)}</TD>
                  <TD className={`text-right ${row.hitPct !== null && row.hitPct < 99 ? "text-warn" : ""}`}>{row.hitPct === null ? "—" : `${row.hitPct.toFixed(1)}%`}</TD>
                  <TD className="max-w-[24rem] truncate" title={row.query}><code>{row.query}</code></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </>
      )}
    </Card>
  );
}
