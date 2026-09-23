export const ROLE_STATUSES = ["auto-matched", "user-shortlisted", "user-dismissed", "archived"] as const;
export type RoleStatus = typeof ROLE_STATUSES[number];
export const ROLE_STATUS_LABELS: Record<RoleStatus, string> = {
  "auto-matched": "Matched", "user-shortlisted": "Shortlisted",
  "user-dismissed": "Dismissed", archived: "Archived",
};
/**
 * The three the tab strip shows, in order: Matched, Shortlisted, Dismissed. Archived is a status
 * like any other — it is what a narrowed gate and a closed-out role become — but it is not a tab:
 * archived roles are a section inside Dismissed, so the strip stays the three things a person acts
 * on. The initial tab is Matched, the day's new roles, unless the account has no matched roles —
 * then it is Shortlisted, which is where someone with nothing new to review is working.
 */
export const ROLE_TABS = ["auto-matched", "user-shortlisted", "user-dismissed"] as const;
export type RoleTab = (typeof ROLE_TABS)[number];
/** Archive takes precedence; automation never overrides an active user decision.
 * Legacy retained non-matches appear in Archive until maintenance records their archive event.
 */
export function roleStatus(job: { archivedAt?: Date | string | null; inTable: boolean }, decision?: { decision: "apply" | "skip" } | null): RoleStatus {
  if (job.archivedAt) return "archived";
  if (decision?.decision === "apply") return "user-shortlisted";
  if (decision?.decision === "skip") return "user-dismissed";
  return job.inTable ? "auto-matched" : "archived";
}

/**
 * Which tab a visit to the roles table opens on: Matched while there is anything new to review,
 * otherwise Shortlisted. Missing counts are treated as zero, so a caller that has not counted a
 * status yet lands on Shortlisted rather than on an empty Matched tab.
 */
export function defaultRoleTab(counts: Partial<Record<RoleStatus, number>>): RoleTab {
  return (counts["auto-matched"] ?? 0) > 0 ? "auto-matched" : "user-shortlisted";
}

// ---------------------------------------------------------------------------
// The lifecycle: one company-role, from one account's point of view
// ---------------------------------------------------------------------------

/**
 * The eight stages a role passes through for one account, in the order it passes through them.
 * The pieces behind them live apart — the gate result and archive marker in `user_jobs`, the
 * apply/skip decision in `decisions`, the CV in `cv_drafts`, the submitted application in
 * `applications` — and this is the single reading of them that the roles table and the
 * applications table both show, so the two can never disagree about where a role has got to.
 */
export const ROLE_STAGES = ["matched", "shortlisted", "applying", "applied", "in_process", "accepted", "rejected", "dismissed"] as const;
export type RoleStage = (typeof ROLE_STAGES)[number];

export const ROLE_STAGE_LABELS: Record<RoleStage, string> = {
  matched: "Matched",
  shortlisted: "Shortlisted",
  applying: "Applying",
  applied: "Applied",
  in_process: "In process",
  accepted: "Accepted",
  rejected: "Rejected",
  dismissed: "Dismissed",
};

/** One plain sentence per stage, for the legend under the table. */
export const ROLE_STAGE_DESCRIPTIONS: Record<RoleStage, string> = {
  matched: "Passed your keyword and location filters; nothing decided yet.",
  shortlisted: "You chose to pursue it.",
  applying: "A CV is being built or is ready; nothing submitted yet.",
  applied: "You recorded an application.",
  in_process: "The employer is considering it: screening, interview or offer.",
  accepted: "You received and accepted an offer.",
  rejected: "The employer said no.",
  dismissed: "You passed on it, withdrew, or it stopped matching and was archived.",
};

/**
 * What an `applications` row can say. Kept identical to `APPLICATION_STATUSES` in @ava/db,
 * which is the column's enum: core cannot import the database package, so the two lists are
 * maintained together and `applicationStage` is the only thing that reads them.
 */
export const APPLICATION_STATUSES = ["applying", "applied", "screening", "interview", "offer", "accepted", "rejected", "withdrawn"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  applying: "Applying",
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  accepted: "Accepted",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** The three statuses that collapse into the single "In process" stage, in the order they happen. */
export const IN_PROCESS_STEPS = ["screening", "interview", "offer"] as const;

/** Where an application status puts the role. Screening, interview and offer are one stage. */
export function applicationStage(status: ApplicationStatus): RoleStage {
  switch (status) {
    case "applying": return "applying";
    case "applied": return "applied";
    case "screening":
    case "interview":
    case "offer": return "in_process";
    case "accepted": return "accepted";
    case "rejected": return "rejected";
    case "withdrawn": return "dismissed";
  }
}

/**
 * The stage of one role for one account, in precedence order:
 *
 * 1. An application row decides. It is the furthest anything has got, so it outranks the decision
 *    behind it — a role skipped after an offer was accepted is Accepted, not Dismissed.
 * 2. Otherwise `archived` or `user-dismissed` is Dismissed: a role the account passed on, or one a
 *    narrowed gate or a closure archived.
 * 3. Otherwise `user-shortlisted` is Applying once a CV exists for the role, else Shortlisted.
 * 4. Otherwise `auto-matched` is Matched.
 *
 * `hasCv` is a live, unarchived CV draft for this role; `applicationStatus` is the newest
 * application row for it, or null when there is none.
 */
export function roleStage(input: { status: RoleStatus; hasCv: boolean; applicationStatus?: ApplicationStatus | null }): RoleStage {
  if (input.applicationStatus) return applicationStage(input.applicationStatus);
  if (input.status === "archived" || input.status === "user-dismissed") return "dismissed";
  if (input.status === "user-shortlisted") return input.hasCv ? "applying" : "shortlisted";
  return "matched";
}

/** Position in `ROLE_STAGES`: what a pipeline table sorts by. */
export function roleStageRank(stage: RoleStage): number {
  return ROLE_STAGES.indexOf(stage);
}

/** Stages still in play — something is expected of the account or the employer. */
export const ACTIVE_ROLE_STAGES = ["shortlisted", "applying", "applied", "in_process"] as const;
/** Stages that are over, however they ended. */
export const CLOSED_ROLE_STAGES = ["accepted", "rejected", "dismissed"] as const;
