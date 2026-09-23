import v8 from "node:v8";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { poolStats, slowQueryCount } from "@ava/db";

export interface Vitals {
  heapUsedMb: number;
  heapLimitMb: number;
  /** Fraction of the V8 heap ceiling in use: the number that says how close the process is to the crash nothing catches. */
  heapFraction: number;
  rssMb: number;
  externalMb: number;
  uptimeSeconds: number;
  /** 99th percentile event-loop delay since boot: how long a ready callback waits behind the work in front of it. */
  eventLoopLagP99Ms: number;
  /** Queries this process has seen take 250 ms or longer, since boot. */
  slowQueries: number;
  /** Connections across this process's database pools. Absent where none is open (the CLI, a test helper). */
  db?: { total: number; idle: number; waiting: number };
}

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

/**
 * Started once, at import, and never reset: the percentiles are cumulative since boot, which is
 * what makes a heartbeat comparable with the one before it. A synchronous stretch — parsing a 40 MB
 * board, gzipping a snapshot — is invisible in heap terms and shows up here as a stalled loop.
 */
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

/**
 * The process's own account of its memory, against the ceiling V8 will kill it at, plus what it is
 * waiting on. An out-of-memory is the one failure no handler sees, so every place that can be asked
 * how the worker is doing (the boot line, task start and end, the heartbeat, /healthz) reports this.
 */
export function vitals(): Vitals {
  const mem = process.memoryUsage();
  const limit = v8.getHeapStatistics().heap_size_limit;
  const pool = poolStats();
  return {
    heapUsedMb: mb(mem.heapUsed),
    heapLimitMb: mb(limit),
    heapFraction: limit > 0 ? Math.round((mem.heapUsed / limit) * 100) / 100 : 0,
    rssMb: mb(mem.rss),
    externalMb: mb(mem.external + mem.arrayBuffers),
    uptimeSeconds: Math.round(process.uptime()),
    eventLoopLagP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
    slowQueries: slowQueryCount(),
    ...(pool ? { db: pool } : {}),
  };
}
