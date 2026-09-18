import v8 from "node:v8";

export interface Vitals {
  heapUsedMb: number;
  heapLimitMb: number;
  /** Fraction of the V8 heap ceiling in use: the number that says how close the process is to the crash nothing catches. */
  heapFraction: number;
  rssMb: number;
  externalMb: number;
  uptimeSeconds: number;
}

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

/**
 * The process's own account of its memory, against the ceiling V8 will kill it at. An
 * out-of-memory is the one failure no handler sees, so every place that can be asked how the
 * worker is doing (the boot line, task start and end, the heartbeat, /healthz) reports this.
 */
export function vitals(): Vitals {
  const mem = process.memoryUsage();
  const limit = v8.getHeapStatistics().heap_size_limit;
  return {
    heapUsedMb: mb(mem.heapUsed),
    heapLimitMb: mb(limit),
    heapFraction: limit > 0 ? Math.round((mem.heapUsed / limit) * 100) / 100 : 0,
    rssMb: mb(mem.rss),
    externalMb: mb(mem.external + mem.arrayBuffers),
    uptimeSeconds: Math.round(process.uptime()),
  };
}
