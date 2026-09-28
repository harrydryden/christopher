/**
 * What the reviewer is told each mark means: when a row earns it and when it does not.
 *
 * Kept apart from `evidence-rubric.ts` so the Library page, which scores live in the browser, does
 * not carry the prompt text; only the A12 prompt reads this.
 */
import type { EvidenceMark } from "./evidence-rubric";

export const EVIDENCE_MARK_RUBRICS: Readonly<Record<EvidenceMark, string>> = {
  "responsibility.scope": "Names the thing they were accountable for — a function, process, product, market, budget, system or portfolio — rather than a job title or a generic duty (\"various tasks\", \"day-to-day operations\").",
  "responsibility.audience": "Says who the work served or answered to: a named team, leadership role, client group, region, business unit or function.",
  "responsibility.ownership": "States the level of accountability with a verb of ownership — led, ran, owned, managed, headed, built, set up, was accountable for, reported to — not a passive \"involved in\" or \"helped with\".",
  "responsibility.scale": "Gives a size or cadence: headcount, budget or revenue figure, number of sites, markets, entities, customers or products, or the frequency of the work.",
  "problem.situation": "Names a concrete problem or state that needed fixing — a backlog, failing process, manual work, overspend, missed deadlines, a risk, gap or complaint — rather than just the task.",
  "problem.constraint": "Says why it was hard or what caused it: a root cause, deadline, budget or headcount limit, legacy system, regulation, or a constraint that had to be worked around.",
  "problem.approach": "Describes the action taken — rebuilt, redesigned, introduced, automated, negotiated, restructured, replaced — specifically enough that a reader knows what changed.",
  "problem.resolution": "Says how the problem ended — fixed, eliminated, avoided, recovered, unblocked, brought within target — so the reader knows the problem was solved, not just worked on.",
  "outcome.change": "States a change in state — reduced, grew, restored, launched, eliminated, from X to Y — not an activity (\"worked on improving\").",
  "outcome.cause": "Connects the change to the person's own action — by, through, after, using — so it reads as their result rather than something that happened around them.",
  "outcome.beneficiary": "Says who or what benefited: customers, a team, the business, revenue, cash, compliance, a risk that went away.",
  "outcome.magnitude": "Gives the magnitude of the change as a figure, percentage, time, currency amount, multiple, or an explicit comparison (from X to Y, halved, first ever, every site).",
  "metric.figure": "Carries a number, percentage, currency amount or measured duration.",
  "metric.measure": "Names the measure the figure belongs to — revenue, margin, cost, cash, churn, retention, NPS, cycle time, error rate, headcount, volume — so the number means something.",
  "metric.movement": "Shows direction and a comparison point — from X to Y, up or down by N, versus target, prior year or baseline — not a bare level.",
  "metric.driver": "Says what the person did that moved the number and, ideally, over what period — a quarter, a year, a programme — so the figure is attributable to them.",
  "milestone.deliverable": "Names a concrete thing completed — a launch, release, migration, go-live, signed deal, passed audit, certification, opened site, closed round — rather than ongoing work.",
  "milestone.timing": "Gives the timing: a date, month, quarter or year, a duration, or how it landed against a deadline (on time, ahead of schedule, in six weeks).",
  "milestone.role": "States the person's part — led, delivered, owned, co-ordinated, or which piece was theirs — rather than an unattributed \"was launched\".",
  "milestone.significance": "Says why the milestone mattered: what it enabled or unblocked, its scale or value, that it was a first or the largest, or what was at stake if it slipped.",
  "style.behaviour": "Names an observable behaviour — coached, facilitated, negotiated, pushed back, wrote it up, ran weekly one-to-ones — rather than a trait word (\"collaborative\", \"strong communicator\").",
  "style.counterpart": "Says who the behaviour was with: a team, peers, direct reports, senior stakeholders, clients, suppliers or another function.",
  "style.instance": "Anchors the behaviour in a real, checkable situation — a named project, moment, system or time — rather than a general claim about how they always are.",
  "style.effect": "Says what the behaviour led to: a decision reached, a delivery kept on track, a relationship repaired, a team retained.",
};
