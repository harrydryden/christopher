/**
 * The days an application is dated by, and the sentences they are read in.
 *
 * Two kinds of day sit on an application and they are not the same thing: the day an entry is
 * *about* — the interview, the offer, the rejection — and the day the next step is due. Both are
 * calendar days rather than instants, because "Tuesday" is not a timestamp, and both are read in
 * UTC, as every other day in this product is.
 *
 * All of it is pure. The applications page turns its rows into these sentences on the server, so
 * the table shows the words the server computed rather than deriving them again against whatever
 * the viewer's clock says.
 */
// The subpath, not the package index: this file is read by the applications table, which is a
// client component, and the index pulls in Node-only modules that no browser bundle can take.
import { APPLICATION_STATUS_LABELS, type ApplicationStatus } from "@christopher/core/role-workflow";

/** Nothing recorded here predates the product by more than a working lifetime of applications. */
export const EARLIEST_DAY = "2000-01-01";
/** A date further ahead than this is a typo, not a plan. */
export const FUTURE_YEARS = 5;

/**
 * Month and weekday names are written out rather than taken from `Intl`, which renders September
 * as "Sept" in en-GB on newer ICU builds. These strings are the product's own copy — "12 Sep",
 * "by Tue 23 Sep" — and they should read the same on every machine that runs it.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A calendar day the browser's date input produces, and nothing else. */
export function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Today, as the calendar day it is in UTC. */
export function todayDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * A day this product will store: a calendar day inside the window an application can honestly sit
 * in. The guard is against a slipped keystroke — 0202-09-12, 2226-09-12 — not against the person.
 */
export function isRecordableDay(value: string, now: Date = new Date()): boolean {
  if (!isCalendarDay(value)) return false;
  const horizon = new Date(Date.UTC(now.getUTCFullYear() + FUTURE_YEARS, now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  // ISO days sort as text, so the window is two string comparisons.
  return value >= EARLIEST_DAY && value <= horizon;
}

/** "12 Sep". */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/** "Tuesday": what a day a few days either side of today is called. */
export function weekdayLabel(day: string): string {
  return WEEKDAYS[new Date(`${day}T00:00:00.000Z`).getUTCDay()]!;
}

/** "Tue 23 Sep": a day far enough ahead that its name alone would not place it. */
export function dayWithWeekdayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return `${SHORT_WEEKDAYS[date.getUTCDay()]} ${dayLabel(day)}`;
}

/** Whole days from one calendar day to another: positive when `day` is still ahead. */
export function daysUntil(day: string, now: Date = new Date()): number {
  return Math.round((Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${todayDay(now)}T00:00:00.000Z`)) / 86_400_000);
}

/**
 * One line of the status history: "Interview · on 12 Sep · saved 10 Sep".
 *
 * The two dates answer different questions and both are shown. `on` is the day the entry is about
 * and is missing from every entry written before the field existed; `at` is when it was saved,
 * which is all those older entries have.
 */
export function historyLine(entry: { status: string; at: string; on?: string }): string {
  const label = APPLICATION_STATUS_LABELS[entry.status as ApplicationStatus] ?? entry.status;
  const on = entry.on && isCalendarDay(entry.on) ? ` · on ${dayLabel(entry.on)}` : "";
  const savedDay = entry.at.slice(0, 10);
  const saved = isCalendarDay(savedDay) ? ` · saved ${dayLabel(savedDay)}` : "";
  return `${label}${on}${saved}`;
}

/** What a row owes next, and whether the day it was owed on has gone by. */
export interface NextStepNote {
  line: string;
  overdue: boolean;
}

/** As much of a row as a next step is read from: the two fields, wherever the row came from. */
export interface NextStepRow {
  application: { nextAction: string | null; nextActionOn: string | null } | null;
}

/** A next step that names an interview is the one the product has a better sentence for. */
const INTERVIEW = /\binterviews?\b/i;

/** Past its date, the weekday alone places it; beyond a week ago it takes the date to be honest. */
const WEEKDAY_MEMORY_DAYS = 6;

/**
 * What this row owes next, as the line the table shows under the stage, or null when the person
 * has not said. Dated and in the future it reads "Next: send references · by Tue 23 Sep"; past its
 * date it stops being a plan and becomes a question — "Interview was Tuesday: record the outcome"
 * — because by then the thing the person wants from the table is somewhere to put the answer.
 */
export function nextStep(row: NextStepRow, now: Date = new Date()): NextStepNote | null {
  const action = (row.application?.nextAction ?? "").trim();
  if (!action) return null;
  const on = row.application?.nextActionOn ?? "";
  if (!isCalendarDay(on)) return { line: `Next: ${action}`, overdue: false };
  const days = daysUntil(on, now);
  if (days < 0) {
    const when = days >= -WEEKDAY_MEMORY_DAYS ? weekdayLabel(on) : dayLabel(on);
    return {
      line: INTERVIEW.test(action) ? `Interview was ${when}: record the outcome` : `${action} was ${when}: record what happened`,
      overdue: true,
    };
  }
  if (days === 0) return { line: `Next: ${action} · today`, overdue: false };
  if (days === 1) return { line: `Next: ${action} · tomorrow`, overdue: false };
  return { line: `Next: ${action} · by ${dayWithWeekdayLabel(on)}`, overdue: false };
}

/** The same, as the sentence alone. */
export function nextStepLine(row: NextStepRow, now: Date = new Date()): string | null {
  return nextStep(row, now)?.line ?? null;
}

/** How far ahead the Applications header looks when it counts what is owed. */
export const DUE_WITHIN_DAYS = 7;

/** "2 next steps due in the next 7 days", or nothing at all when none are. */
export function dueLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} next ${count === 1 ? "step" : "steps"} due in the next ${DUE_WITHIN_DAYS} days`;
}
