import type { StatementTotals } from "@ava/db";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { formatCount } from "@/lib/format";
import type { RouteVitals } from "@/lib/queries/health";
import { formatVital, VITAL_METRICS, VITALS_SAMPLE_RATE, vitalRating } from "@/lib/web-vitals";

const RATING_TONE = { good: "", "needs-improvement": "text-warn", poor: "text-danger" } as const;

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
