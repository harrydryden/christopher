export const CAPACITY_DATABASE = "christopher_worker_capacity_1g_20260920";

export function validateCapacityDatabase(raw) {
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "host.docker.internal"].includes(url.hostname);
  if (!local || decodeURIComponent(url.pathname.slice(1)) !== CAPACITY_DATABASE)
    throw new Error(`capacity drill requires local database ${CAPACITY_DATABASE}`);
  return url;
}

export function summariseSamples(samples) {
  if (!samples.length) return { peakRssMiB: 0, peakCgroupMiB: 0, peakAnonMiB: 0, peakFileMiB: 0, cpuSeconds: 0 };
  return {
    peakRssMiB: Math.max(...samples.map(s => s.rssMiB)),
    peakCgroupMiB: Math.max(...samples.map(s => s.cgroupMiB)),
    peakAnonMiB: Math.max(...samples.map(s => s.anonMiB ?? 0)),
    peakFileMiB: Math.max(...samples.map(s => s.fileMiB ?? 0)),
    cpuSeconds: +((samples.at(-1).cpuUsec - samples[0].cpuUsec) / 1_000_000).toFixed(3),
    memoryEvents: samples.at(-1).memoryEvents ?? {},
  };
}
