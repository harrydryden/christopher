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
