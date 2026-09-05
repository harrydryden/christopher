export type DisplayStatus = "new" | "active" | "closed";

export interface StatusInput {
  status: "open" | "closed";
  postedAt: Date | null;
  firstSeenAt: Date;
  closedAt: Date | null;
}

export const NEW_WINDOW_DAYS = 7;

export function liveStart(job: Pick<StatusInput, "postedAt" | "firstSeenAt">): { date: Date; basis: "posted" | "first_seen" } {
  if (job.postedAt && job.postedAt.getTime() <= job.firstSeenAt.getTime() + 86_400_000) return { date: job.postedAt, basis: "posted" };
  return { date: job.firstSeenAt, basis: "first_seen" };
}

export function displayStatus(job: StatusInput, now: Date = new Date()): DisplayStatus {
  if (job.status === "closed") return "closed";
  const { date } = liveStart(job);
  const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
  return ageDays <= NEW_WINDOW_DAYS ? "new" : "active";
}

export function liveFor(job: StatusInput, now: Date = new Date()): { days: number; basis: "posted" | "first_seen" } {
  const { date, basis } = liveStart(job);
  const end = job.status === "closed" && job.closedAt ? job.closedAt : now;
  const days = Math.max(0, Math.floor((end.getTime() - date.getTime()) / 86_400_000));
  return { days, basis };
}

export function formatDuration(days: number): string {
  if (days < 1) return "today";
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}
