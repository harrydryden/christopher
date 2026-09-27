import type { StatementTotals } from "@ava/db";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Table, TBody, TD, TH, THead, TR } from "@/components/table";
import { formatCount } from "@/lib/format";

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
