import { relativeTime } from "./format";

/**
 * The four facts the status strip at the top of every page says, for one account. Everything here
 * is plain data so the server can render it and `/api/scan-status` can send it to an open tab.
 */
export interface ScanStripFacts {
  /** The shared run is in progress right now. */
  scanning: boolean;
  /** When a scan of a company this account follows last completed, as ISO, or null if none has. */
  lastScanAt: string | null;
  /** Companies this account actively follows. */
  following: number;
  /** Roles the account's gate admitted that it has not decided on: the Matched tab's count. */
  newRoleMatches: number;
  /** Company suggestions waiting for a yes or no. */
  newCompanyMatches: number;
}

/** The Roles tab that holds the roles still to review. */
export const REVIEW_HREF = "/?view=auto-matched#roles";

export interface ScanStripItem {
  key: "last-scan" | "following" | "roles" | "companies";
  text: string;
  /** The page that holds what the number counts. */
  href: string;
  title: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The strip's four facts, in order, each a short label and a number or a time. */
export function scanStripItems(facts: ScanStripFacts, now: Date): ScanStripItem[] {
  const last = facts.lastScanAt ? new Date(facts.lastScanAt) : null;
  return [
    {
      key: "last-scan",
      text: `Last scan ${last ? relativeTime(last, now) : "not yet"}`,
      href: "/health",
      title: "The most recent completed scan of a company you follow. Open scan history for details.",
    },
    { key: "following", text: `Following ${plural(facts.following, "company", "companies")}`, href: "/companies", title: "Companies you follow" },
    { key: "roles", text: plural(facts.newRoleMatches, "new role match", "new role matches"), href: REVIEW_HREF, title: "Roles your filters admitted that you have not decided on yet" },
    { key: "companies", text: plural(facts.newCompanyMatches, "new company match", "new company matches"), href: "/suggestions", title: "Suggested companies waiting for your answer" },
  ];
}

/** Whether two readings say the same thing, so a poller can tell a change from a repeat. */
export function scanStripSignature(facts: ScanStripFacts): string {
  return [facts.scanning ? 1 : 0, facts.lastScanAt ?? "", facts.following, facts.newRoleMatches, facts.newCompanyMatches].join("|");
}
