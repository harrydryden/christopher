const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Match the UTC creation day used by the persistent daily version ledger. */
export function cvVersionLabel(createdAt: Date | string, version: number): string {
  const date = new Date(createdAt);
  return `${String(date.getUTCDate()).padStart(2, "0")}-${MONTHS[date.getUTCMonth()]}-V${version}`;
}
