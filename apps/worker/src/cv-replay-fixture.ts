/**
 * A synthetic draft for exercising the record → replay → grade gate without a key: a realistic
 * Library and advert, built once through the real handler against the scripted client
 * (`apps/web/test/scripted-ai-client.ts`), so the draft carries an assessment and a kept evidence
 * plan exactly as a published CV does. Used by `cv-replay.test.ts` and `scripts/cv-replay-fixture.mts`.
 * No real person's data: the candidate, the employers and the advert are invented.
 */
import { createUser, enqueueTask, schema, type Db } from "@ava/db";
import { dedupeKeyFor } from "@ava/core";
import type { AiClientLike } from "@ava/ai";
import { eq } from "drizzle-orm";
import type { WorkerDeps } from "./context";
import { TaskQueue } from "./queue";
import { handleGenerateCv } from "./handlers/cv";
import { onAbandon } from "./handlers/abandon";

export const REPLAY_FIXTURE_MODEL = "claude-fable-5-1";

export const REPLAY_FIXTURE_DESCRIPTION = [
  "Head of Operations — Meridian Care Group",
  "",
  "We are hiring a Head of Operations to own service delivery for a portfolio of twelve sites and to lead a team of four operations managers.",
  "You will own the operational plan for the portfolio and report performance to the executive team each month.",
  "You will lead continuous improvement work across scheduling, rostering and supplier performance.",
  "You will partner with finance to build the annual budget and to track monthly variance.",
  "Candidates must have at least five years of experience leading operations in a regulated environment.",
  "You must be able to build and interpret reporting in SQL or a comparable analytics tool.",
  "Experience of supplier negotiation is preferred.",
  "A degree or equivalent professional qualification is required.",
  "",
  "We offer a competitive salary, a pension and twenty-eight days of holiday.",
].join("\n");

const HEAD = [
  "Own the operational plan for eleven community clinics, reporting delivery, cost and quality to the executive team every month.",
  "Lead four operations managers and a shared scheduling team of eighteen, running a weekly performance review against published measures.",
  "Rebuilt rostering around a single demand model, which cut agency spend by 22% in the first year.",
  "Partner with finance on the annual budget and on monthly variance across a £14m cost base.",
  "Introduced a supplier scorecard covering the eight largest contracts, with quarterly reviews against agreed service levels.",
];
const MANAGER = [
  "Ran day-to-day operations for four clinics, owning the rota, the patient flow and the site budget.",
  "Built the first operational reporting pack in SQL and Power BI, replacing a manual month-end spreadsheet.",
  "Managed the transition of two acquired clinics onto the group's systems and ways of working.",
];
const CALDER = [
  "Led a service desk of nine covering two distribution centres and a national customer base.",
  "Owned the service level agreement with the group's three largest retail customers and chaired the monthly review.",
  "Negotiated supplier renewals for courier and warehousing contracts worth £2m a year.",
];

export const REPLAY_FIXTURE_LIBRARY = {
  name: "Rowan Mercer",
  contact: "Manchester, UK · rowan.mercer@example.test",
  profile: "Operations leader with twelve years across regulated healthcare and logistics, accountable for multi-site service delivery, supplier performance and the annual operating budget.",
  employment: [
    { id: "emp-head", company: "Northwind Health", industryDescriptions: "Healthcare, Regulated services", jobTitle: "Head of Operations", startDate: "2021-04", endDate: "", current: true },
    { id: "emp-manager", company: "Northwind Health", industryDescriptions: "Healthcare, Regulated services", jobTitle: "Operations Manager", startDate: "2018-01", endDate: "2021-03", current: false },
    { id: "emp-calder", company: "Calder Logistics", industryDescriptions: "Logistics, Supply chain", jobTitle: "Service Delivery Lead", startDate: "2014-09", endDate: "2017-12", current: false },
  ],
  entries: [
    { id: "ev-head", kind: "experience" as const, employmentId: "emp-head", heading: "Head of Operations · Northwind Health", details: HEAD.join("\n"), confirmedResponsibilities: HEAD },
    { id: "ev-manager", kind: "experience" as const, employmentId: "emp-manager", heading: "Operations Manager · Northwind Health", details: MANAGER.join("\n"), confirmedResponsibilities: MANAGER },
    { id: "ev-calder", kind: "experience" as const, employmentId: "emp-calder", heading: "Service Delivery Lead · Calder Logistics", details: CALDER.join("\n"), confirmedResponsibilities: CALDER },
    { id: "ev-education", kind: "education" as const, heading: "Education", details: "BSc (Hons) Economics, University of Manchester, 2014\nPRINCE2 Practitioner, APMG International, 2019" },
    { id: "ev-skills", kind: "skill" as const, heading: "Systems and tools", details: "Reporting and planning systems used day to day.", skillItems: ["SQL", "Power BI", "NetSuite", "Process mapping", "Vendor management"] },
  ],
};

/**
 * The fixture draft, published: seeded for a fixture account (created once) and built through the
 * real queue and handler against `client`. Throws when it does not publish.
 */
export async function publishReplayFixture(deps: WorkerDeps, client: AiClientLike, email = "cv-replay-fixture@example.invalid") {
  const [existing] = await deps.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  const user = existing ?? (await createUser(deps.db, { email, name: "Replay fixture", role: "member", emailVerified: true })).user;
  const draft = await seedReplayFixtureDraft(deps.db, user.id);
  const previous = { client: deps.aiClient, key: deps.env.anthropicApiKey };
  deps.aiClient = client;
  deps.env.anthropicApiKey ||= "scripted-client";
  try {
    await new TaskQueue(deps, { generate_cv: handleGenerateCv }, { concurrency: 1, workerId: "cv-replay-fixture", onAbandon }).drain();
  } finally {
    deps.aiClient = previous.client;
    deps.env.anthropicApiKey = previous.key;
  }
  const [built] = await deps.db.select().from(schema.cvDrafts).where(eq(schema.cvDrafts.id, draft.id));
  if (built?.status !== "ready") throw new Error(`The fixture draft did not publish: ${built?.status} ${built?.error ?? ""}`);
  return built;
}

/** A queued, planned draft for `userId`, with its build task: drain the queue to publish it. */
export async function seedReplayFixtureDraft(db: Db, userId: string) {
  const [draft] = await db.insert(schema.cvDrafts).values({
    userId, jobTitle: "Head of Operations", companyName: "Meridian Care Group", jobDescription: REPLAY_FIXTURE_DESCRIPTION,
    libraryVersion: 1, librarySnapshot: REPLAY_FIXTURE_LIBRARY, model: REPLAY_FIXTURE_MODEL,
    // Planned, with the optional questions already answered, so the build runs straight through to
    // publication, keeps its plan and tries the optional improvement.
    buildCheckpoint: { tailoringEnabled: true, quizCompleted: true },
  }).returning();
  const payload = { draftId: draft!.id, userId };
  await enqueueTask(db, "generate_cv", payload, { dedupeKey: dedupeKeyFor("generate_cv", payload) });
  return draft!;
}
