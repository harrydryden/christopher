/**
 * Database schema for Christopher. See docs/SPEC.md section 5.
 * Conventions: snake_case columns, timestamptz everywhere, uuid primary keys.
 */
import type { CvLibrary, CvContent } from "@christopher/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const tsNow = (name: string) => ts(name).notNull().defaultNow();

export const COMPANY_STATUSES = ["active", "paused", "archived"] as const;
export const SOURCE_TYPES = [
  "greenhouse", "lever", "ashby", "workable", "smartrecruiters", "recruitee", "personio",
  "bamboohr", "workday", "pinpoint", "breezy", "jsonld", "rss", "html",
] as const;
export const SOURCE_STATUSES = ["active", "needs_confirmation", "failing", "blocked", "disabled"] as const;
export const SCAN_STATUSES = ["ok", "partial", "suspect_empty", "failed"] as const;
export const FETCH_METHODS = ["api", "http", "browser"] as const;
export const JOB_STATUSES = ["open", "closed"] as const;
export const DECISIONS = ["apply", "skip"] as const;
export const TASK_TYPES = [
  "discover", "scan_company", "run_daily", "fetch_description", "score_job", "tag_reason",
  "synthesize_profile", "suggest_filters", "profile_company", "suggest_companies", "rescore_all",
  "reevaluate_gate", "generate_cv",
] as const;
export const TASK_STATUSES = ["queued", "running", "done", "failed"] as const;

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  homepageUrl: text("homepage_url").notNull(),
  domain: text("domain").notNull().unique(),
  faviconUrl: text("favicon_url"),
  status: text("status", { enum: COMPANY_STATUSES }).notNull().default("active"),
  notes: text("notes"),
  addedAt: tsNow("added_at"),
  archivedAt: ts("archived_at"),
});

export const careerSources = pgTable(
  "career_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    type: text("type", { enum: SOURCE_TYPES }).notNull(),
    url: text("url").notNull(),
    apiUrl: text("api_url"),
    atsSlug: text("ats_slug"),
    atsSite: text("ats_site"),
    discoveryMethod: text("discovery_method"),
    confidence: real("confidence").notNull().default(0),
    confirmedByUser: boolean("confirmed_by_user").notNull().default(false),
    recipe: jsonb("recipe"),
    contentHash: text("content_hash"),
    status: text("status", { enum: SOURCE_STATUSES }).notNull().default("active"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastOkScanAt: ts("last_ok_scan_at"),
    lastPostingsCount: integer("last_postings_count"),
    createdAt: tsNow("created_at"),
    verifiedAt: ts("verified_at"),
  },
  (t) => [index("career_sources_company_idx").on(t.companyId)],
);

export const discoveryRuns = pgTable("discovery_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  startedAt: tsNow("started_at"),
  finishedAt: ts("finished_at"),
  status: text("status", { enum: ["running", "resolved", "needs_confirmation", "not_found", "failed"] }).notNull().default("running"),
  candidates: jsonb("candidates").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  chosenSourceId: uuid("chosen_source_id"),
  log: jsonb("log").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  error: text("error"),
});

export const scanRuns = pgTable("scan_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: tsNow("started_at"),
  finishedAt: ts("finished_at"),
  runDate: text("run_date").notNull(), // YYYY-MM-DD in the configured timezone; one scheduled run per day
  trigger: text("trigger", { enum: ["schedule", "manual"] }).notNull(),
  companiesTotal: integer("companies_total").notNull().default(0),
  companiesOk: integer("companies_ok").notNull().default(0),
  companiesFailed: integer("companies_failed").notNull().default(0),
  newRoles: integer("new_roles").notNull().default(0),
  closedRoles: integer("closed_roles").notNull().default(0),
});

export const scans = pgTable(
  "scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanRunId: uuid("scan_run_id").references(() => scanRuns.id, { onDelete: "set null" }),
    sourceId: uuid("source_id").notNull().references(() => careerSources.id, { onDelete: "cascade" }),
    startedAt: tsNow("started_at"),
    finishedAt: ts("finished_at"),
    status: text("status", { enum: SCAN_STATUSES }).notNull(),
    fetchMethod: text("fetch_method", { enum: FETCH_METHODS }),
    postingsFound: integer("postings_found").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    closedCount: integer("closed_count").notNull().default(0),
    error: text("error"),
    durationMs: integer("duration_ms"),
    rawSnapshot: text("raw_snapshot"),
  },
  (t) => [index("scans_source_started_idx").on(t.sourceId, t.startedAt)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").notNull().references(() => careerSources.id, { onDelete: "cascade" }),
    externalKey: text("external_key").notNull(),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    url: text("url").notNull(),
    location: text("location"),
    locations: jsonb("locations").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    department: text("department"),
    employmentType: text("employment_type"),
    remote: boolean("remote"),
    salaryText: text("salary_text"),
    postedAt: ts("posted_at"),
    firstSeenAt: tsNow("first_seen_at"),
    lastSeenAt: tsNow("last_seen_at"),
    closedAt: ts("closed_at"),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("open"),
    missingScans: integer("missing_scans").notNull().default(0),
    seeded: boolean("seeded").notNull().default(false),
    reopenedCount: integer("reopened_count").notNull().default(0),
    repostOfJobId: uuid("repost_of_job_id"),
    descriptionText: text("description_text"),
    descriptionHash: text("description_hash"),
    descriptionFetchedAt: ts("description_fetched_at"),
    keywordMatched: boolean("keyword_matched").notNull().default(false),
    keywordTerms: jsonb("keyword_terms").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    excluded: boolean("excluded").notNull().default(false),
    locationOk: boolean("location_ok").notNull().default(true),
    inTable: boolean("in_table").notNull().default(false),
    nearMiss: boolean("near_miss").notNull().default(false),
    fitScore: integer("fit_score"),
    fitVerdict: text("fit_verdict", { enum: ["strong", "possible", "unlikely"] }),
    fitRationale: text("fit_rationale"),
    fitProfileVersion: integer("fit_profile_version"),
    fitScoredAt: ts("fit_scored_at"),
    hidden: boolean("hidden").notNull().default(false),
    archivedAt: ts("archived_at"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [
    uniqueIndex("jobs_source_external_key_uidx").on(t.sourceId, t.externalKey),
    index("jobs_company_status_idx").on(t.companyId, t.status),
    index("jobs_table_idx").on(t.inTable, t.status, t.fitScore),
    index("jobs_first_seen_idx").on(t.firstSeenAt),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    type: text("type", {
      enum: ["discovered", "updated", "closed", "reopened", "scored", "decided", "hidden", "unhidden", "description_fetched"],
    }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    at: tsNow("at"),
  },
  (t) => [index("job_events_job_idx").on(t.jobId, t.at)],
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    decision: text("decision", { enum: DECISIONS }).notNull(),
    reason: text("reason").notNull().default(""),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    tagsEdited: boolean("tags_edited").notNull().default(false),
    superseded: boolean("superseded").notNull().default(false),
    // Denormalised snapshot so the learning corpus survives job/company deletion.
    jobTitle: text("job_title").notNull(),
    companyName: text("company_name").notNull(),
    jobLocation: text("job_location"),
    jobDepartment: text("job_department"),
    descriptionSnippet: text("description_snippet"),
    fitScoreAtDecision: integer("fit_score_at_decision"),
    createdAt: tsNow("created_at"),
  },
  (t) => [
    uniqueIndex("decisions_active_job_uidx").on(t.jobId).where(sql`${t.superseded} = false`),
    index("decisions_created_idx").on(t.createdAt),
  ],
);

export const tagVocabulary = pgTable("tag_vocabulary", {
  tag: text("tag").primaryKey(),
  description: text("description"),
  createdBy: text("created_by", { enum: ["seed", "model", "user"] }).notNull().default("seed"),
  accepted: boolean("accepted").notNull().default(true),
  createdAt: tsNow("created_at"),
});

export const preferenceProfiles = pgTable("preference_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull().unique(),
  markdown: text("markdown").notNull(),
  pinnedStatements: jsonb("pinned_statements").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  openQuestions: jsonb("open_questions").$type<Array<{ id: string; question: string; answer?: string }>>().notNull().default(sql`'[]'::jsonb`),
  sourceDecisionCount: integer("source_decision_count").notNull().default(0),
  model: text("model"),
  generatedAt: tsNow("generated_at"),
});

export const filterSuggestions = pgTable("filter_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type", { enum: ["keyword_include", "keyword_exclude", "location", "pause_company", "hide_threshold"] }).notNull(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  evidence: jsonb("evidence").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
  rationale: text("rationale"),
  status: text("status", { enum: ["pending", "accepted", "rejected"] }).notNull().default("pending"),
  createdAt: tsNow("created_at"),
  resolvedAt: ts("resolved_at"),
});

export const companyProfiles = pgTable("company_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  domain: text("domain").notNull(),
  oneLiner: text("one_liner"),
  sector: text("sector"),
  subSector: text("sub_sector"),
  businessModel: text("business_model"),
  customerType: text("customer_type"),
  stage: text("stage"),
  sizeBand: text("size_band"),
  hqCountry: text("hq_country"),
  geographies: jsonb("geographies").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  raw: jsonb("raw"),
  generatedAt: tsNow("generated_at"),
});

export const companySuggestions = pgTable("company_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  homepageUrl: text("homepage_url").notNull(),
  domain: text("domain").notNull().unique(),
  profileId: uuid("profile_id").references(() => companyProfiles.id, { onDelete: "set null" }),
  rationale: text("rationale"),
  similarTo: jsonb("similar_to").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  verification: jsonb("verification").$type<{
    homepageOk: boolean;
    careersSource?: { type: string; url: string; confidence: number } | null;
    openRoles?: number;
    matchingRoles?: number;
    error?: string;
  }>(),
  rank: integer("rank"),
  status: text("status", { enum: ["pending", "accepted", "rejected", "expired"] }).notNull().default("pending"),
  rejectionReason: text("rejection_reason"),
  createdAt: tsNow("created_at"),
  resolvedAt: ts("resolved_at"),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: tsNow("updated_at"),
});

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type", { enum: TASK_TYPES }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    dedupeKey: text("dedupe_key"),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("queued"),
    priority: integer("priority").notNull().default(5), // lower runs first
    runAfter: tsNow("run_after"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedAt: ts("locked_at"),
    lockedBy: text("locked_by"),
    error: text("error"),
    result: jsonb("result"),
    createdAt: tsNow("created_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("tasks_status_run_after_idx").on(t.status, t.priority, t.runAfter),
    uniqueIndex("tasks_dedupe_active_uidx").on(t.dedupeKey).where(sql`${t.status} in ('queued', 'running') and ${t.dedupeKey} is not null`),
  ],
);

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callSite: text("call_site").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    durationMs: integer("duration_ms"),
    ok: boolean("ok").notNull().default(true),
    error: text("error"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    at: tsNow("at"),
  },
  (t) => [index("ai_calls_at_idx").on(t.at)],
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type CareerSource = typeof careerSources.$inferSelect;
export type NewCareerSource = typeof careerSources.$inferInsert;
export type DiscoveryRun = typeof discoveryRuns.$inferSelect;
export type ScanRun = typeof scanRuns.$inferSelect;
export type Scan = typeof scans.$inferSelect;
export type NewScan = typeof scans.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobEvent = typeof jobEvents.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type PreferenceProfile = typeof preferenceProfiles.$inferSelect;
export type FilterSuggestion = typeof filterSuggestions.$inferSelect;
export type CompanyProfile = typeof companyProfiles.$inferSelect;
export type CompanySuggestion = typeof companySuggestions.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type AiCall = typeof aiCalls.$inferSelect;
export type TaskType = (typeof TASK_TYPES)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];


export const cvLibraries = pgTable("cv_libraries", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull().unique(),
  content: jsonb("content").$type<CvLibrary>().notNull(),
  createdAt: tsNow("created_at"),
});
export const cvDrafts = pgTable("cv_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  jobTitle: text("job_title").notNull(),
  companyName: text("company_name").notNull(),
  jobDescription: text("job_description").notNull(),
  libraryVersion: integer("library_version").notNull(),
  librarySnapshot: jsonb("library_snapshot").$type<CvLibrary>().notNull(),
  model: text("model").notNull(),
  status: text("status", { enum: ["queued", "generating", "ready", "failed"] }).notNull().default("queued"),
  content: jsonb("content").$type<CvContent>(),
  error: text("error"),
  revision: integer("revision").notNull().default(0),
  parentId: uuid("parent_id"),
  createdAt: tsNow("created_at"),
});
