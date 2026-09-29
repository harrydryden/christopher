import { describe, expect, it } from "vitest";
import { buildSetupChecklist, monitoringNotice, setupMilestones, type SetupFacts } from "./setup";

const NOTHING: SetupFacts = {
  emailConfirmed: false, gateChosen: false, seedProfileWritten: false,
  companiesFollowed: 0, libraryFilled: false, dismissedAt: null,
  monitoring: { activeCompanies: 0, successfulCompanies: 0, attentionCompanies: 0, pendingCompanies: 0, lastSuccessAt: null },
};
const WATCHING: SetupFacts = {
  ...NOTHING, emailConfirmed: true, gateChosen: true, companiesFollowed: 1,
  monitoring: { ...NOTHING.monitoring, activeCompanies: 1 },
};
const COMPLETE: SetupFacts = {
  ...WATCHING, monitoring: { ...WATCHING.monitoring, successfulCompanies: 1, lastSuccessAt: "2026-09-29T08:00:00Z" },
};

describe("outcome-based setup", () => {
  it("requires the first successful scan, without making profile or Library a monitoring prerequisite", () => {
    expect(buildSetupChecklist(NOTHING).steps.map(step => [step.id, step.href])).toEqual([
      ["email", "/account"], ["gate", "/settings#keywords"], ["companies", "/suggestions"], ["first-scan", "/companies"],
    ]);
    expect(buildSetupChecklist(NOTHING)).toMatchObject({ summary: "0 of 4 done", complete: false, nextStep: { id: "email" } });
    expect(buildSetupChecklist(WATCHING)).toMatchObject({ summary: "3 of 4 done", complete: false, nextStep: { id: "first-scan" } });
    expect(buildSetupChecklist(COMPLETE)).toMatchObject({ summary: "4 of 4 done", complete: true, nextStep: null });
    expect(buildSetupChecklist({ ...NOTHING, libraryFilled: true, seedProfileWritten: true }).doneCount).toBe(0);
  });

  it("requires an active followed company, not a paused subscription or an arbitrary quota of three", () => {
    expect(buildSetupChecklist({ ...NOTHING, companiesFollowed: 3 }).steps[2]!.done).toBe(false);
    expect(buildSetupChecklist(WATCHING).steps[2]).toMatchObject({ done: true, progress: "1 following" });
  });

  it("dismissal hides guidance without faking completion", () => {
    expect(buildSetupChecklist({ ...NOTHING, dismissedAt: "2026-09-29T08:00:00Z" })).toMatchObject({ dismissed: true, complete: false, doneCount: 0 });
  });

  it("marks exactly one next step, even when earlier steps were skipped", () => {
    const states = (facts: SetupFacts) => setupMilestones(buildSetupChecklist(facts)).map(step => step.state);
    expect(states(NOTHING)).toEqual(["current", "todo", "todo", "todo"]);
    expect(states({ ...COMPLETE, emailConfirmed: false })).toEqual(["current", "done", "done", "done"]);
    expect(states(COMPLETE)).toEqual(["done", "done", "done", "done"]);
  });
});

describe("empty-result explanations", () => {
  it("distinguishes preferences, paused companies, waiting and successful empty views", () => {
    expect(monitoringNotice(NOTHING).state).toBe("preferences");
    expect(monitoringNotice({ ...NOTHING, gateChosen: true })).toMatchObject({ state: "no-companies", href: "/suggestions" });
    expect(monitoringNotice({ ...NOTHING, gateChosen: true, companiesFollowed: 2 })).toMatchObject({ state: "no-companies", href: "/companies" });
    expect(monitoringNotice(WATCHING).state).toBe("waiting");
    expect(monitoringNotice(COMPLETE)).toMatchObject({ state: "complete", title: "Your companies have been checked" });
  });

  it("does not imply all companies succeeded when only the first has been checked", () => {
    expect(monitoringNotice({ ...COMPLETE, monitoring: { ...COMPLETE.monitoring, activeCompanies: 3 } })).toMatchObject({ state: "waiting", title: "1 of 3 companies checked" });
  });

  it("makes queued work visible, and gives unresolved attention precedence over previous success", () => {
    expect(monitoringNotice({ ...COMPLETE, monitoring: { ...COMPLETE.monitoring, pendingCompanies: 1 } }).state).toBe("working");
    const failed = { ...COMPLETE, monitoring: { ...COMPLETE.monitoring, attentionCompanies: 1, pendingCompanies: 1 } };
    expect(monitoringNotice(failed)).toMatchObject({ state: "attention", href: "/health" });
    expect(buildSetupChecklist(failed).steps[3]!.href).toBe("/health");
  });
});
