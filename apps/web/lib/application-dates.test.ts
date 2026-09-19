/**
 * The sentences an application's two kinds of day are read in.
 *
 * A next step is a plan until its day passes and a question afterwards, and the table has to say
 * which without the person doing the arithmetic. Every case here is fixed against one "now", so
 * the words do not depend on the day the suite runs.
 */
import { describe, expect, it } from "vitest";
import {
  dayLabel,
  dayWithWeekdayLabel,
  daysUntil,
  dueLine,
  historyLine,
  isCalendarDay,
  isRecordableDay,
  nextStep,
  nextStepLine,
  todayDay,
  weekdayLabel,
} from "./application-dates";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const step = (nextAction: string | null, nextActionOn: string | null = null) => ({
  application: { nextAction, nextActionOn },
});

describe("a day this product will store", () => {
  it("takes what the date input produces and nothing else", () => {
    expect(isCalendarDay("2026-09-12")).toBe(true);
    expect(isCalendarDay("2026-02-30")).toBe(false);
    expect(isCalendarDay("12/09/2026")).toBe(false);
    expect(isCalendarDay("2026-09-12T09:00:00Z")).toBe(false);
    expect(isCalendarDay("")).toBe(false);
  });

  it("refuses a slipped keystroke either side of the window", () => {
    expect(isRecordableDay("2026-09-12", NOW)).toBe(true);
    expect(isRecordableDay("2000-01-01", NOW)).toBe(true);
    expect(isRecordableDay("1999-12-31", NOW)).toBe(false);
    expect(isRecordableDay("0202-09-12", NOW)).toBe(false);
    // Five years ahead is a plan; the day after it is a typo.
    expect(isRecordableDay("2031-09-19", NOW)).toBe(true);
    expect(isRecordableDay("2031-09-20", NOW)).toBe(false);
    expect(isRecordableDay("2026-02-30", NOW)).toBe(false);
  });

  it("names days the way the product's own copy does", () => {
    expect(todayDay(NOW)).toBe("2026-09-19");
    expect(dayLabel("2026-09-12")).toBe("12 Sep");
    expect(dayLabel("2026-01-05")).toBe("5 Jan");
    expect(weekdayLabel("2026-09-15")).toBe("Tuesday");
    expect(dayWithWeekdayLabel("2026-09-23")).toBe("Wed 23 Sep");
    expect(daysUntil("2026-09-19", NOW)).toBe(0);
    expect(daysUntil("2026-09-20", NOW)).toBe(1);
    expect(daysUntil("2026-09-15", NOW)).toBe(-4);
  });
});

describe("one line of the status history", () => {
  it("shows the day the entry is about beside the day it was saved", () => {
    expect(historyLine({ status: "interview", at: "2026-09-10T08:30:00.000Z", on: "2026-09-12" })).toBe(
      "Interview · on 12 Sep · saved 10 Sep",
    );
  });

  it("falls back to the save time alone for an entry written before the day existed", () => {
    expect(historyLine({ status: "applied", at: "2026-09-10T08:30:00.000Z" })).toBe("Applied · saved 10 Sep");
    expect(historyLine({ status: "applied", at: "2026-09-10T08:30:00.000Z", on: "not a day" })).toBe("Applied · saved 10 Sep");
    // A status or a save time this build does not recognise is still shown, never dropped.
    expect(historyLine({ status: "hired", at: "sometime" })).toBe("hired");
  });
});

describe("what a row owes next", () => {
  it("says nothing when the person has not said", () => {
    expect(nextStepLine({ application: null }, NOW)).toBeNull();
    expect(nextStepLine(step(null), NOW)).toBeNull();
    expect(nextStepLine(step("   "), NOW)).toBeNull();
    expect(nextStep(step("", "2026-09-23"), NOW)).toBeNull();
  });

  it("reads as a plan while its day is still ahead", () => {
    expect(nextStepLine(step("send references", "2026-09-23"), NOW)).toBe("Next: send references · by Wed 23 Sep");
    expect(nextStepLine(step("send references", "2026-09-19"), NOW)).toBe("Next: send references · today");
    expect(nextStepLine(step("send references", "2026-09-20"), NOW)).toBe("Next: send references · tomorrow");
    expect(nextStep(step("send references", "2026-09-23"), NOW)!.overdue).toBe(false);
  });

  it("keeps an undated step as a plain note", () => {
    expect(nextStepLine(step("chase the recruiter"), NOW)).toBe("Next: chase the recruiter");
    // A day the input could not have produced is no day at all, not a reason to say nothing.
    expect(nextStepLine(step("chase the recruiter", "next tuesday"), NOW)).toBe("Next: chase the recruiter");
    expect(nextStep(step("chase the recruiter"), NOW)!.overdue).toBe(false);
  });

  it("becomes a question once its day has gone by", () => {
    expect(nextStepLine(step("Second interview", "2026-09-15"), NOW)).toBe("Interview was Tuesday: record the outcome");
    expect(nextStepLine(step("send references", "2026-09-18"), NOW)).toBe("send references was Friday: record what happened");
    expect(nextStep(step("send references", "2026-09-18"), NOW)!.overdue).toBe(true);
    // Beyond a week "was Tuesday" would be the wrong Tuesday, so the date is given instead.
    expect(nextStepLine(step("send references", "2026-09-01"), NOW)).toBe("send references was 1 Sep: record what happened");
    expect(nextStepLine(step("Interview with the panel", "2026-08-20"), NOW)).toBe("Interview was 20 Aug: record the outcome");
  });
});

describe("what the header says is due", () => {
  it("counts next steps, and says nothing when none are", () => {
    expect(dueLine(0)).toBeNull();
    expect(dueLine(-1)).toBeNull();
    expect(dueLine(1)).toBe("1 next step due in the next 7 days");
    expect(dueLine(4)).toBe("4 next steps due in the next 7 days");
  });
});
