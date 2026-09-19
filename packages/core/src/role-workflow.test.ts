import { expect, it } from "vitest";
import {
  ACTIVE_ROLE_STAGES, APPLICATION_STATUSES, APPLICATION_STATUS_LABELS, applicationStage, CLOSED_ROLE_STAGES,
  defaultRoleTab, IN_PROCESS_STEPS, ROLE_STAGE_DESCRIPTIONS, ROLE_STAGE_LABELS, ROLE_STAGES, ROLE_STATUSES,
  ROLE_STATUS_LABELS, ROLE_TABS, roleStage, roleStageRank, roleStatus, type ApplicationStatus, type RoleStage,
} from "./role-workflow";
it("keeps user choices independent of matching and puts archive first", () => {
  for (const inTable of [true, false]) {
    expect(roleStatus({ inTable }, { decision: "apply" })).toBe("user-shortlisted");
    expect(roleStatus({ inTable }, { decision: "skip" })).toBe("user-dismissed");
    expect(roleStatus({ inTable, archivedAt: new Date() }, { decision: "apply" })).toBe("archived");
  }
  expect(roleStatus({ inTable: true })).toBe("auto-matched");
  expect(roleStatus({ inTable: false })).toBe("archived");
});

it("names the statuses for a person and leaves archive out of the tab strip", () => {
  // The keys are URL values and SQL; only the labels and their order are the interface's.
  expect(ROLE_STATUSES).toEqual(["auto-matched", "user-shortlisted", "user-dismissed", "archived"]);
  expect(ROLE_STATUSES.map((status) => ROLE_STATUS_LABELS[status])).toEqual(["Matched", "Shortlisted", "Dismissed", "Archived"]);
  expect(ROLE_TABS).toEqual(["auto-matched", "user-shortlisted", "user-dismissed"]);
  expect(ROLE_TABS).not.toContain("archived");
});

it("opens on Matched while anything is new, and on Shortlisted once nothing is", () => {
  expect(defaultRoleTab({ "auto-matched": 4, "user-shortlisted": 0 })).toBe("auto-matched");
  expect(defaultRoleTab({ "auto-matched": 1 })).toBe("auto-matched");
  expect(defaultRoleTab({ "auto-matched": 0, "user-shortlisted": 3 })).toBe("user-shortlisted");
  // A caller that has not counted the tab at all lands where an empty Matched tab would send it.
  expect(defaultRoleTab({})).toBe("user-shortlisted");
  expect(defaultRoleTab({ "user-shortlisted": 2 })).toBe("user-shortlisted");
});

it("names every stage and describes it in one sentence", () => {
  expect(ROLE_STAGES).toEqual(["matched", "shortlisted", "applying", "applied", "in_process", "accepted", "rejected", "dismissed"]);
  expect(ROLE_STAGES.map((stage) => ROLE_STAGE_LABELS[stage])).toEqual([
    "Matched", "Shortlisted", "Applying", "Applied", "In process", "Accepted", "Rejected", "Dismissed",
  ]);
  for (const stage of ROLE_STAGES) expect(ROLE_STAGE_DESCRIPTIONS[stage]).toMatch(/^[A-Z].*\.$/);
  expect(ROLE_STAGE_DESCRIPTIONS.in_process).toBe("The employer is considering it: screening, interview or offer.");
  expect(APPLICATION_STATUSES.map((status) => APPLICATION_STATUS_LABELS[status])).toEqual([
    "Applying", "Applied", "Screening", "Interview", "Offer", "Accepted", "Rejected", "Withdrawn",
  ]);
});

it("maps every application status onto a stage, collapsing the employer's steps into one", () => {
  const expected: Record<ApplicationStatus, RoleStage> = {
    applying: "applying", applied: "applied", screening: "in_process", interview: "in_process",
    offer: "in_process", accepted: "accepted", rejected: "rejected", withdrawn: "dismissed",
  };
  for (const status of APPLICATION_STATUSES) expect(applicationStage(status)).toBe(expected[status]);
  for (const step of IN_PROCESS_STEPS) expect(applicationStage(step)).toBe("in_process");
  // No status is left without a stage, and none invents one.
  expect(new Set(APPLICATION_STATUSES.map(applicationStage)).size).toBe(6);
});

it("reads the stage in precedence order: the application, then the decision, then the gate", () => {
  // An application is the furthest anything has got: it outranks the skip recorded behind it.
  expect(roleStage({ status: "user-dismissed", hasCv: false, applicationStatus: "accepted" })).toBe("accepted");
  expect(roleStage({ status: "user-dismissed", hasCv: true, applicationStatus: "interview" })).toBe("in_process");
  expect(roleStage({ status: "archived", hasCv: false, applicationStatus: "applied" })).toBe("applied");
  // Archive beats a CV that was built before the gate narrowed or the role closed.
  expect(roleStage({ status: "archived", hasCv: true })).toBe("dismissed");
  expect(roleStage({ status: "user-dismissed", hasCv: true, applicationStatus: null })).toBe("dismissed");
  // Shortlisted, with and without a CV for the role.
  expect(roleStage({ status: "user-shortlisted", hasCv: true })).toBe("applying");
  expect(roleStage({ status: "user-shortlisted", hasCv: false })).toBe("shortlisted");
  // Nothing decided yet.
  expect(roleStage({ status: "auto-matched", hasCv: false })).toBe("matched");
  expect(roleStage({ status: "auto-matched", hasCv: true })).toBe("matched");
});

it("ranks the stages in lifecycle order, and splits them into what is live and what is over", () => {
  const ranks = ROLE_STAGES.map(roleStageRank);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  for (let i = 1; i < ranks.length; i++) expect(ranks[i]!).toBeGreaterThan(ranks[i - 1]!);
  expect(roleStageRank("matched")).toBe(0);
  expect(roleStageRank("dismissed")).toBe(ROLE_STAGES.length - 1);
  expect([...ACTIVE_ROLE_STAGES, ...CLOSED_ROLE_STAGES].every((stage) => ROLE_STAGES.includes(stage))).toBe(true);
  expect(new Set([...ACTIVE_ROLE_STAGES, ...CLOSED_ROLE_STAGES]).size).toBe(ACTIVE_ROLE_STAGES.length + CLOSED_ROLE_STAGES.length);
});
