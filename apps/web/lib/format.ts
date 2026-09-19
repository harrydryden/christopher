/** Presentation helpers: relative time, currency, percentages. Pure functions, no I/O. */

export function relativeTime(date: Date | null | undefined, now: Date = new Date()): string {
  if (!date) return "never";
  const diffMs = now.getTime() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  if (sec < 45) return future ? "in a moment" : "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return future ? `in ${hr}h` : `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return future ? `in ${day}d` : `${day}d ago`;
  const week = Math.round(day / 7);
  if (day < 60) return future ? `in ${week}w` : `${week}w ago`;
  const month = Math.round(day / 30);
  if (day < 365) return future ? `in ${month}mo` : `${month}mo ago`;
  const year = Math.round(day / 365);
  return future ? `in ${year}y` : `${year}y ago`;
}

export function isoOrUndefined(date: Date | null | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

export function formatUsd(n: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Whole figures with thousands separators: token and call counts, which run to seven digits. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-GB").format(Math.round(n));
}

/** "17 Sep". Read in UTC because a budget month and its reset marker are UTC. */
export function shortDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

/** "41 MB". Scan inputs run from a few KB to the tens of megabytes that exhaust the worker's heap. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/** "45s", "3m 20s", "2h 5m": how long something has been running, against a deadline in the same shape. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** "+12%", "-4%", "—" when there is nothing to compare against: a week-over-week change. */
export function formatDelta(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? "—" : "new";
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return "level";
  return `${change > 0 ? "+" : "\u2212"}${Math.abs(change * 100).toFixed(0)}%`;
}

/** "340ms", "2.4s", "18s": a latency, which spans three orders of magnitude here. */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

/** Costs below a cent, which is what one scored role and one stage of a build come to. */
export function formatUsdPrecise(n: number): string {
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return formatUsd(n);
}

export function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function pluralize(n: number, singular: string, plural: string = `${singular}s`): string {
  return n === 1 ? singular : plural;
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  discovered: "Discovered",
  updated: "Updated",
  closed: "Closed",
  reopened: "Reopened",
  scored: "Scored",
  decided: "Decided",
  hidden: "Hidden",
  unhidden: "Unhidden",
  description_fetched: "Description fetched",
};

const SCAN_STATUS_LABELS: Record<string, string> = {
  ok: "Scanned",
  partial: "Partial scan",
  suspect_empty: "Empty scan",
  failed: "Scan failed",
};

/** Prose form of a scan status, for a sentence rather than a badge. */
export function scanStatusLabel(status: string): string {
  return SCAN_STATUS_LABELS[status] ?? status;
}

export function eventTypeLabel(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? type;
}

/**
 * A CV build motion's duration, at the precision the figure deserves: "0.3 s" for reading the
 * library, "52 s" for a rubric, "3 min" for the writing call. Whole minutes rather than "3m 12s"
 * once a step runs past a minute, because the narrative line is read, not scanned in a table.
 */
export function formatStepDuration(ms: number): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)} s`;
  const seconds = Math.round(safe / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds ? `${minutes} min ${restSeconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`;
}

/**
 * "18:10:25" in the deployment's timezone. The build narrative is a log, so it carries clock
 * times rather than "2m ago"; the timezone is the shared one from Admin › System settings, the
 * same one the scan banner reads, and UTC when a caller has none.
 */
export function formatClock(date: Date, timeZone = "UTC", withSeconds = true): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" as const } : {}), hour12: false })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  // en-GB with hour12 off renders midnight as 24 in some ICU builds, as localDateParts also guards.
  const hour = parts.hour === "24" ? "00" : parts.hour ?? "00";
  return `${hour}:${parts.minute ?? "00"}${withSeconds ? `:${parts.second ?? "00"}` : ""}`;
}
