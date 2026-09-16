/**
 * Database schema for Christopher. See docs/SPEC.md section 5.
 * Conventions: snake_case columns, timestamptz everywhere, uuid primary keys.
 *
 * Two kinds of table live here:
 *  - shared: companies, careers sources, discovery runs, scans and the observed postings (`jobs`).
 *    The discovery engine and the daily scan are system-wide, so every company is stored once
 *    and scanned once a day however many people follow it.
 *  - per user: everything that expresses a person's choices. `company_subscriptions` says who
 *    follows which company, `user_jobs` holds one person's gate result, fit score and archive
 *    marker for a shared posting, and decisions, profiles, CVs and settings all carry a `user_id`.
 */
import type { CvLibrary, CvContent } from "@christopher/core";
import type { CvAssessment, CvJobSource } from "@christopher/core/cv-assessment";
import { sql } from "drizzle-orm";
import { cvRoleKey } from "./cv-role-key";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
  "bamboohr", "workday", "pinpoint", "breezy",
  "teamtailor", "icims", "jobvite", "jazzhr", "rippling", "successfactors", "eightfold",
  "jsonld", "rss", "html",
] as const;
export const SOURCE_STATUSES = ["active", "needs_confirmation", "failing", "blocked", "disabled"] as const;
export const SCAN_STATUSES = ["ok", "partial", "suspect_empty", "failed"] as const;
export const FETCH_METHODS = ["api", "http", "browser"] as const;
export const JOB_STATUSES = ["open", "closed"] as const;
export const DECISIONS = ["apply", "skip"] as const;
export const USER_ROLES = ["admin", "member"] as const;
export const AUTH_PROVIDERS = ["google"] as const;
export const AUTH_TOKEN_PURPOSES = ["password_reset", "email_verification"] as const;
export const TASK_TYPES = [
  "extract_document", "verify_company", "monitor_source", "discover", "scan_company", "run_daily", "fetch_description", "score_job", "tag_reason",
  "synthesize_profile", "suggest_filters", "suggest_from_scans", "profile_company", "suggest_companies", "rescore_all",
  "reevaluate_gate", "generate_cv",
] as const;
export const TASK_STATUSES = ["queued", "running", "done", "failed"] as const;

// ---------------------------------------------------------------------------
// Accounts and sessions
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stored lowercase; the login form normalises before lookup. */
  email: text("email").notNull().unique(),
  emailVerifiedAt: ts("email_verified_at"),
  name: text("name"),
  /** scrypt hash, or null for an account that only signs in with Google. */
  passwordHash: text("password_hash"),
  role: text("role", { enum: USER_ROLES }).notNull().default("member"),
  /**
   * The owner account created by the multi-user migration holds the data of the previous
   * single-user deployment and has no way to sign in until the first person to register claims
   * it. Every account created through the interface is claimed at birth.
   */
  claimedAt: ts("claimed_at"),
  createdAt: tsNow("created_at"),
  lastLoginAt: ts("last_login_at"),
});

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: AUTH_PROVIDERS }).notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email"),
    name: text("name"),
    createdAt: tsNow("created_at"),
  },
  (t) => [
    uniqueIndex("auth_accounts_provider_uidx").on(t.provider, t.providerAccountId),
    index("auth_accounts_user_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: tsNow("created_at"),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: tsNow("last_seen_at"),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/** Single-use links for password resets and email verification. Only a hash of the token is stored. */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: AUTH_TOKEN_PURPOSES }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: tsNow("created_at"),
  },
  (t) => [index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose)],
);

/** Distributed login throttling: one row per failed or sensitive attempt, keyed by email or address. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    at: tsNow("at"),
  },
  (t) => [index("login_attempts_key_at_idx").on(t.key, t.at)],
);

/** Per-user settings (keywords, locations, seed profile, CV preferences). System settings stay in `settings`. */
export const userSettings = pgTable(
  "user_settings",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// ---------------------------------------------------------------------------
// Shared company catalogue
// ---------------------------------------------------------------------------

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  homepageUrl: text("homepage_url").notNull(),
  domain: text("domain").notNull().unique(),
  faviconUrl: text("favicon_url"),
  /**
   * Derived from subscriptions: active while anyone follows the company actively, paused while
   * every follower has paused it, archived when nobody follows it. Kept as a column so the
   * scheduler and the scan handler can read it without a join; `syncCompanyStatus` maintains it.
   */
  status: text("status", { enum: COMPANY_STATUSES }).notNull().default("active"),
  addedAt: tsNow("added_at"),
  archivedAt: ts("archived_at"),
});

/** Who follows which company. Notes, pause and archive are the follower's own. */
export const companySubscriptions = pgTable(
  "company_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    status: text("status", { enum: COMPANY_STATUSES }).notNull().default("active"),
    notes: text("notes"),
    addedAt: tsNow("added_at"),
    archivedAt: ts("archived_at"),
  },
  (t) => [
    uniqueIndex("company_subscriptions_user_company_uidx").on(t.userId, t.companyId),
    index("company_subscriptions_company_idx").on(t.companyId, t.status),
  ],
);

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
    nextScanAt: ts("next_scan_at"),
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
  (t) => [index("scans_source_started_idx").on(t.sourceId, t.startedAt), index("scans_run_idx").on(t.scanRunId)],
);

/** Every posting observed on a shared source. Which of them a person sees is decided in `user_jobs`. */
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
    descriptionSource: text("description_source", { enum: ["direct", "model"] }),
    descriptionTruncated: boolean("description_truncated").notNull().default(false),
    descriptionHash: text("description_hash"),
    descriptionFetchedAt: ts("description_fetched_at"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [
    uniqueIndex("jobs_source_external_key_uidx").on(t.sourceId, t.externalKey),
    index("jobs_company_status_idx").on(t.companyId, t.status),
    index("jobs_first_seen_idx").on(t.firstSeenAt),
  ],
);

/**
 * One person's view of a shared posting: their gate result, fit score and archive marker.
 * A row exists only once the posting passed that person's gate (or they decided on it), which
 * keeps "store matching roles only" true per account while the shared scan keeps everything.
 */
export const userJobs = pgTable(
  "user_jobs",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
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
    /** True when the row was created for a posting the scan had already seen (day-one of a subscription). */
    seeded: boolean("seeded").notNull().default(false),
    archivedAt: ts("archived_at"),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.jobId] }),
    index("user_jobs_job_idx").on(t.jobId),
    index("user_jobs_table_idx").on(t.userId, t.inTable, t.archivedAt, t.fitScore),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    /** Null for observations shared by everyone (discovered, updated, closed…); set for one person's events. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
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
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
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
    uniqueIndex("decisions_active_job_uidx").on(t.userId, t.jobId).where(sql`${t.superseded} = false`),
    index("decisions_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const tagVocabulary = pgTable(
  "tag_vocabulary",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    description: text("description"),
    createdBy: text("created_by", { enum: ["seed", "model", "user"] }).notNull().default("seed"),
    accepted: boolean("accepted").notNull().default(true),
    createdAt: tsNow("created_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tag] })],
);

export const preferenceProfiles = pgTable(
  "preference_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    markdown: text("markdown").notNull(),
    pinnedStatements: jsonb("pinned_statements").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    openQuestions: jsonb("open_questions").$type<Array<{ id: string; question: string; answer?: string }>>().notNull().default(sql`'[]'::jsonb`),
    sourceDecisionCount: integer("source_decision_count").notNull().default(0),
    model: text("model"),
    generatedAt: tsNow("generated_at"),
  },
  (t) => [uniqueIndex("preference_profiles_user_version_uidx").on(t.userId, t.version)],
);

export const filterSuggestions = pgTable(
  "filter_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["keyword_include", "keyword_exclude", "seniority_include", "location", "pause_company", "hide_threshold"] }).notNull(),
    value: jsonb("value").$type<Record<string, unknown>>().notNull(),
    evidence: jsonb("evidence").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    rationale: text("rationale"),
    status: text("status", { enum: ["pending", "accepted", "rejected"] }).notNull().default("pending"),
    createdAt: tsNow("created_at"),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("filter_suggestions_user_status_idx").on(t.userId, t.status)],
);

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

export const discoverySources = pgTable("discovery_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["website", "email", "linkedin"] }).notNull(),
  url: text("url"),
  enabled: boolean("enabled").notNull().default(true),
  intervalDays: integer("interval_days").notNull().default(7),
  nextRunAt: tsNow("next_run_at"),
  lastCheckedAt: ts("last_checked_at"),
  lastError: text("last_error"),
  createdAt: tsNow("created_at"),
}, t => [index("discovery_sources_due_idx").on(t.nextRunAt).where(sql`${t.enabled} = true`), index("discovery_sources_user_idx").on(t.userId)]);

export const discoveryDocuments = pgTable("discovery_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => discoverySources.id, { onDelete: "cascade" }),
  url: text("url"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  fingerprint: text("fingerprint").notNull(),
  processedAt: ts("processed_at"),
  createdAt: tsNow("created_at"),
}, (t) => [uniqueIndex("discovery_document_dedupe").on(t.sourceId, t.fingerprint), index("discovery_document_pending_idx").on(t.sourceId, t.createdAt).where(sql`${t.processedAt} is null`)]);

export const companySuggestions = pgTable("company_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  homepageUrl: text("homepage_url").notNull(),
  domain: text("domain").notNull(),
  profileId: uuid("profile_id").references(() => companyProfiles.id, { onDelete: "set null" }),
  evidence: jsonb("evidence").$type<{ sourceName: string; url?: string; title: string; quote: string }>(),
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
}, t => [
  uniqueIndex("company_suggestions_user_domain_uidx").on(t.userId, t.domain),
  index("suggestions_review_idx").on(t.userId, t.status, t.rank, t.createdAt),
  index("suggestions_history_idx").on(t.userId, t.status, t.resolvedAt),
]);

/** System-wide settings (schedule, models, budget) and the worker's internal bookkeeping. */
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
    index("tasks_scan_run_idx").on(sql`(${t.payload}->>'scanRunId')`, t.status),
    index("tasks_source_status_idx").on(sql`(${t.payload}->>'sourceId')`, t.status, t.createdAt),
    index("tasks_lane_idx").on(t.type, t.status, t.priority, t.runAfter),
    uniqueIndex("tasks_dedupe_active_uidx").on(t.dedupeKey).where(sql`${t.status} in ('queued', 'running') and ${t.dedupeKey} is not null`),
  ],
);

export const aiCalls = pgTable(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The account the call was made for, when there is one; shared work such as extraction has none. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthAccount = typeof authAccounts.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuthToken = typeof authTokens.$inferSelect;
export type UserSetting = typeof userSettings.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type CompanySubscription = typeof companySubscriptions.$inferSelect;
export type CareerSource = typeof careerSources.$inferSelect;
export type NewCareerSource = typeof careerSources.$inferInsert;
export type DiscoveryRun = typeof discoveryRuns.$inferSelect;
export type ScanRun = typeof scanRuns.$inferSelect;
export type Scan = typeof scans.$inferSelect;
export type NewScan = typeof scans.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type UserJob = typeof userJobs.$inferSelect;
export type NewUserJob = typeof userJobs.$inferInsert;
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
export type UserRole = (typeof USER_ROLES)[number];


export const cvLibraries = pgTable("cv_libraries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  content: jsonb("content").$type<CvLibrary>().notNull(),
  createdAt: tsNow("created_at"),
}, t => [uniqueIndex("cv_libraries_user_version_uidx").on(t.userId, t.version)]);
export const cvDrafts = pgTable("cv_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  jobTitle: text("job_title").notNull(),
  companyName: text("company_name").notNull(),
  jobDescription: text("job_description").notNull(),
  jobSource: jsonb("job_source").$type<CvJobSource>(),
  assessment: jsonb("assessment").$type<CvAssessment>(),
  finalisedAt: ts("finalised_at"),
  libraryVersion: integer("library_version").notNull(),
  librarySnapshot: jsonb("library_snapshot").$type<CvLibrary>().notNull(),
  model: text("model").notNull(),
  status: text("status", { enum: ["queued", "generating", "ready", "failed"] }).notNull().default("queued"),
  buildStage: text("build_stage", { enum: ["analysing", "writing", "fitting", "assessing"] }),
  content: jsonb("content").$type<CvContent>(),
  error: text("error"),
  revision: integer("revision").notNull().default(0),
  parentId: uuid("parent_id"),
  /** One archived predecessor is retained per person, company and role. */
  archivedAt: ts("archived_at"),
  createdAt: tsNow("created_at"),
}, table => [
  index("cv_drafts_role_key_idx").on(cvRoleKey(table.userId, table.companyName, table.jobTitle)),
  index("cv_drafts_user_idx").on(table.userId, table.archivedAt, table.createdAt),
]);

/** Version ledger survives retention/deletion; contains identifiers only, no CV content. */
export const cvVersions = pgTable("cv_versions", {
  cvId: uuid("cv_id").primaryKey(),
  roleKey: text("role_key").notNull(),
  day: text("day").notNull(),
  version: integer("version").notNull(),
}, table => [uniqueIndex("cv_versions_role_day_version_idx").on(table.roleKey, table.day, table.version)]);

/** Submitted PDF bytes and company/role snapshots survive deletion of their source CV. */
export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  cvId: uuid("cv_id").references(() => cvDrafts.id, { onDelete: "set null" }),
  jobTitle: text("job_title").notNull(),
  companyName: text("company_name").notNull(),
  appliedOn: text("applied_on").notNull(),
  pdfBase64: text("pdf_base64").notNull(),
  status: text("status").notNull().default("applied"),
  notes: text("notes").notNull().default(""),
  history: jsonb("history").$type<Array<{ status: string; at: string; notes: string }>>().notNull(),
  createdAt: tsNow("created_at"),
}, t => [index("applications_user_idx").on(t.userId, t.appliedOn)]);

/** Renewable operation locks do not retain a connection while doing network work. */
export const resourceLeases = pgTable("resource_leases", {
  key: text("key").primaryKey(),
  owner: uuid("owner").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const discoveryCandidates = pgTable("discovery_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").references(() => discoveryDocuments.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  name: text("name").notNull(),
  homepageUrl: text("homepage_url").notNull(),
  rationale: text("rationale").notNull(),
  quote: text("quote").notNull(),
  similarTo: jsonb("similar_to").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rank: integer("rank"),
  batchKey: text("batch_key"),
  processedAt: ts("processed_at"),
  createdAt: tsNow("created_at"),
}, t => [uniqueIndex("discovery_candidate_document_domain").on(t.documentId, t.domain), uniqueIndex("discovery_candidate_batch_domain").on(t.batchKey, t.domain)]);

export const verificationCache = pgTable("verification_cache", {
  key: text("key").primaryKey(),
  result: jsonb("result").$type<NonNullable<typeof companySuggestions.$inferSelect.verification>>().notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const hostPacing = pgTable("host_pacing", {
  host: text("host").primaryKey(),
  nextAt: ts("next_at").notNull(),
});

export const aiReservations = pgTable("ai_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  callSite: text("call_site").notNull(),
  amount: real("amount").notNull(),
  createdAt: tsNow("created_at"),
  expiresAt: ts("expires_at").notNull(),
});
export const aiSpendPeriods = pgTable("ai_spend_periods", {
  key: text("key").primaryKey(),
  amount: real("amount").notNull().default(0),
});
