import { describe, expect, it } from "vitest";
import { buildSetupChecklist, COMPANIES_TARGET, setupMilestones, type SetupFacts } from "./setup";

const NOTHING: SetupFacts = {
  emailConfirmed: false,
  gateChosen: false,
  seedProfileWritten: false,
  companiesFollowed: 0,
  libraryFilled: false,
  dismissedAt: null,
};

const EVERYTHING: SetupFacts = {
  emailConfirmed: true,
  gateChosen: true,
  seedProfileWritten: true,
  companiesFollowed: COMPANIES_TARGET,
  libraryFilled: true,
  dismissedAt: null,
};

describe("buildSetupChecklist", () => {
  it("is five steps in the order the work is done, each linking to the field that finishes it", () => {
    const checklist = buildSetupChecklist(NOTHING);
    expect(checklist.steps.map((step) => [step.id, step.href])).toEqual([
      ["email", "/account"],
      ["gate", "/settings#keywords"],
      ["seed-profile", "/settings#seed-profile"],
      ["companies", "/companies#add"],
      ["library", "/library"],
    ]);
    expect(checklist.total).toBe(5);
    expect(checklist.steps.every((step) => step.label && step.description)).toBe(true);
  });

  it("counts what is done and names the next step", () => {
    const checklist = buildSetupChecklist(NOTHING);
    expect(checklist.doneCount).toBe(0);
    expect(checklist.summary).toBe("0 of 5 done");
    expect(checklist.complete).toBe(false);
    expect(checklist.nextStep?.id).toBe("email");

    const started = buildSetupChecklist({ ...NOTHING, emailConfirmed: true, gateChosen: true });
    expect(started.doneCount).toBe(2);
    expect(started.summary).toBe("2 of 5 done");
    expect(started.nextStep?.id).toBe("seed-profile");
  });

  it("names the next undone step even when an earlier one was skipped", () => {
    // Someone can fill the Library before confirming their address; the checklist still points at
    // the first thing outstanding rather than the last thing done.
    const checklist = buildSetupChecklist({ ...NOTHING, libraryFilled: true, seedProfileWritten: true });
    expect(checklist.nextStep?.id).toBe("email");
    expect(checklist.doneCount).toBe(2);
  });

  it("shows the company step as a count out of three and finishes it at three", () => {
    expect(buildSetupChecklist(NOTHING).steps[3]).toMatchObject({ done: false, progress: "0 of 3", label: "Follow 3 companies" });
    expect(buildSetupChecklist({ ...NOTHING, companiesFollowed: 1 }).steps[3]).toMatchObject({ done: false, progress: "1 of 3" });
    expect(buildSetupChecklist({ ...NOTHING, companiesFollowed: 3 }).steps[3]).toMatchObject({ done: true, progress: "3 of 3" });
    // More than three is still three: the count is a target, not a score.
    expect(buildSetupChecklist({ ...NOTHING, companiesFollowed: 9 }).steps[3]).toMatchObject({ done: true, progress: "3 of 3" });
    expect(buildSetupChecklist({ ...NOTHING, companiesFollowed: -1 }).steps[3]).toMatchObject({ done: false, progress: "0 of 3" });
  });

  it("is complete with nothing left to do once every fact is true", () => {
    const checklist = buildSetupChecklist(EVERYTHING);
    expect(checklist.complete).toBe(true);
    expect(checklist.doneCount).toBe(5);
    expect(checklist.summary).toBe("5 of 5 done");
    expect(checklist.nextStep).toBeNull();
  });

  it("reads the dismissal marker without letting it change what is done", () => {
    expect(buildSetupChecklist(NOTHING).dismissed).toBe(false);
    const hidden = buildSetupChecklist({ ...NOTHING, dismissedAt: "2026-09-19T08:00:00.000Z" });
    expect(hidden.dismissed).toBe(true);
    expect(hidden.complete).toBe(false);
    expect(hidden.doneCount).toBe(0);
  });
});

describe("setupMilestones", () => {
  it("marks done steps, exactly one current step, and the rest to do", () => {
    const states = (facts: SetupFacts) => setupMilestones(buildSetupChecklist(facts)).map((step) => step.state);
    expect(states(NOTHING)).toEqual(["current", "todo", "todo", "todo", "todo"]);
    expect(states({ ...NOTHING, emailConfirmed: true, gateChosen: true })).toEqual(["done", "done", "current", "todo", "todo"]);
    // A step skipped early is the one pointed at, even with later ones finished.
    expect(states({ ...NOTHING, libraryFilled: true, seedProfileWritten: true })).toEqual(["current", "todo", "done", "todo", "done"]);
    expect(states(EVERYTHING)).toEqual(["done", "done", "done", "done", "done"]);
  });

  it("gives every milestone a short label and a one-sentence description for the line beneath", () => {
    for (const step of setupMilestones(buildSetupChecklist(NOTHING))) {
      expect(step.shortLabel.length).toBeGreaterThan(0);
      expect(step.shortLabel.length).toBeLessThanOrEqual(12);
      expect(step.description.replace(/\.$/, "")).not.toContain(". ");
    }
  });
});
