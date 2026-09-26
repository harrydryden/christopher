/**
 * Database schema for AVA. See docs/SPEC.md section 5.
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
import type { CvLibrary, CvContent, LibraryEntryReview } from "@ava/core";
import type { CvAssessment, CvJobSource } from "@ava/core/cv-assessment";
import type { CvTailoringPlan } from "@ava/core/cv-tailoring";
import type { CvBuildCheckpoint, CvBuildFailure, CvBuildMotion, CvBuildStage, CvBuildStepStatus, CvGapQuiz } from "@ava/core";
import { sql } from "drizzle-orm";
import { cvRoleKey } from "./cv-role-key";
import {
  bigint,
  boolean,
  customType,
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
/** Where a posting came from: the daily scan of a source, or a follower who pasted its URL. */
export const JOB_ORIGINS = ["scan", "user"] as const;
/**
 * Why one account's view of a posting carries the fit score it carries — or none.
 *
 * A blank score covered five different situations and the table could not tell them apart:
 * waiting, scored, never scored because the posting closed first, skipped because the account had
 * nothing left to spend, and not eligible (neither in the table nor shortlisted) when the task
 * ran. The score handler already decides all five; this records which one it decided.
 */
export const SCORE_STATES = ["queued", "scored", "closed", "budget", "ineligible"] as const;
export type ScoreState = (typeof SCORE_STATES)[number];
/** Where captured logo bytes came from. Mirrors `LOGO_SOURCES` in @ava/core. */
export const LOGO_SOURCES = ["site_icon", "icon_service"] as const;
export const NAME_SUGGESTION_STATUSES = ["pending", "applied", "dismissed"] as const;
export const DECISIONS = ["apply", "skip"] as const;
/**
 * What an `applications` row can say. Mirrors `APPLICATION_STATUSES` in @ava/core, which
 * maps each one onto a role stage; the two lists are maintained together because core cannot
 * import this package. "applying" is the stage a person sets from the table before anything is
 * submitted, which is why `pdf_base64` is nullable.
 */
export const APPLICATION_STATUSES = ["applying", "applied", "screening", "interview", "offer", "accepted", "rejected", "withdrawn"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const USER_ROLES = ["admin", "member"] as const;
export const AUTH_PROVIDERS = ["google"] as const;
export const AUTH_TOKEN_PURPOSES = ["password_reset", "email_verification"] as const;
export const TASK_TYPES = [
  "extract_document", "verify_company", "monitor_source", "discover", "scan_company", "run_daily", "fetch_description", "score_job", "tag_reason",
  "synthesize_profile", "suggest_filters", "suggest_from_scans", "profile_company", "suggest_companies", "rescore_all",
  "reevaluate_gate", "generate_cv", "import_posting", "review_library", "import_library_document",
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
  (t) => [
    index("auth_tokens_user_purpose_idx").on(t.userId, t.purpose),
    index("auth_tokens_expires_idx").on(t.expiresAt),
    index("auth_tokens_used_idx").on(t.usedAt).where(sql`${t.usedAt} is not null`),
  ],
);

/** Distributed login throttling: one row per failed or sensitive attempt, keyed by email or address. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    at: tsNow("at"),
  },
  (t) => [index("login_attempts_key_at_idx").on(t.key, t.at), index("login_attempts_at_idx").on(t.at)],
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
  /**
   * Where the stored logo was captured from, and the browser's fallback while nothing is stored.
   * The image the interface serves is the one in `company_logos`; this is a URL, not the bytes.
   */
  faviconUrl: text("favicon_url"),
  /** When the bytes in `company_logos` were stored. The interface versions the image URL with it. */
  logoFetchedAt: ts("logo_fetched_at"),
  /** Failed capture attempts since the last success; drives the retry backoff. */
  logoAttempts: integer("logo_attempts").notNull().default(0),
  /** Null means "capture whenever it is due"; a future time means "not before then". */
  logoNextAttemptAt: ts("logo_next_attempt_at"),
  logoError: text("logo_error"),
  /** The account that put the company in the shared catalogue, when one did. */
  addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
  /**
   * Derived from subscriptions: active while anyone follows the company actively, paused while
   * every follower has paused it, archived when nobody follows it. Kept as a column so the
   * scheduler and the scan handler can read it without a join; `syncCompanyStatus` maintains it.
   */
  status: text("status", { enum: COMPANY_STATUSES }).notNull().default("active"),
  addedAt: tsNow("added_at"),
  archivedAt: ts("archived_at"),
});

/**
 * The company logo as bytes, captured once by the worker and served by the interface everywhere.
 * A remote icon URL is not enough: the roles table and the company page disagreed because some
 * sites serve their icon to a browser and refuse ours, so what a page showed depended on who
 * asked. Base64 for the same reason `applications.pdf_base64` is: one column, no large-object
 * plumbing, and a row that travels with a dump. Bounded by `LOGO_MAX_BYTES` at capture time.
 */
export const companyLogos = pgTable("company_logos", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  contentType: text("content_type").notNull(),
  dataBase64: text("data_base64").notNull(),
  byteLength: integer("byte_length").notNull(),
  source: text("source", { enum: LOGO_SOURCES }).notNull(),
  sourceUrl: text("source_url").notNull(),
  fetchedAt: tsNow("fetched_at"),
});

/**
 * A follower's proposed name for a company in the shared catalogue — the case a person adds a
 * company before anyone has confirmed its careers page, when the name taken from the domain is
 * often wrong. The catalogue is shared, so the rename itself is an administrator's; this is the
 * proposal and who made it.
 */
export const companyNameSuggestions = pgTable(
  "company_name_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note"),
    status: text("status", { enum: NAME_SUGGESTION_STATUSES }).notNull().default("pending"),
    createdAt: tsNow("created_at"),
    resolvedAt: ts("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("company_name_suggestions_company_status_idx").on(t.companyId, t.status)],
);

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
}, (t) => [index("discovery_runs_company_started_idx").on(t.companyId, t.startedAt.desc()), index("discovery_runs_started_idx").on(t.startedAt)]);

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
    /**
     * Bytes this scan actually transferred: the listing and every page it read, excluding a body the
     * fetcher served from its own cache after a 304 and including a browser render. `requests` and
     * `revalidated` say how many requests that took and how many of them cost nothing.
     */
    fetchedBytes: integer("fetched_bytes"),
    requests: integer("requests"),
    revalidated: integer("revalidated"),
    rawSnapshot: text("raw_snapshot"),
  },
  (t) => [index("scans_source_started_idx").on(t.sourceId, t.startedAt), index("scans_run_idx").on(t.scanRunId), index("scans_started_idx").on(t.startedAt)],
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
    /**
     * When an open posting was first missing from a successful scan; cleared whenever a scan lists
     * it. The closing miss must come at least `MIN_CLOSE_SEPARATION_MS` after this, so two misses
     * are two observations rather than one made twice.
     */
    firstMissedAt: ts("first_missed_at"),
    seeded: boolean("seeded").notNull().default(false),
    reopenedCount: integer("reopened_count").notNull().default(0),
    repostOfJobId: uuid("repost_of_job_id"),
    descriptionText: text("description_text"),
    descriptionSource: text("description_source", { enum: ["direct", "model"] }),
    descriptionTruncated: boolean("description_truncated").notNull().default(false),
    descriptionHash: text("description_hash"),
    descriptionFetchedAt: ts("description_fetched_at"),
    /**
     * `scan` for a posting a source's listing produced, `user` for one a follower pasted the URL
     * of. A scan never closes a `user` row — it was never in a listing to go missing from — but a
     * later scan that observes the same URL adopts the row and it becomes an ordinary posting.
     */
    origin: text("origin", { enum: JOB_ORIGINS }).notNull().default("scan"),
    /** The account that pasted the URL, for a posting with `origin = 'user'`. */
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * False for a posting pasted from a host that is not the company's own: it is kept for the
     * account that pasted it (`added_by`) and never offered to any other follower's gate.
     */
    shared: boolean("shared").notNull().default(true),
    createdAt: tsNow("created_at"),
    updatedAt: tsNow("updated_at"),
  },
  (t) => [
    uniqueIndex("jobs_source_external_key_uidx").on(t.sourceId, t.externalKey),
    index("jobs_company_status_idx").on(t.companyId, t.status),
    index("jobs_first_seen_idx").on(t.firstSeenAt),
    index("jobs_company_origin_idx").on(t.companyId, t.origin),
    // Created by migration 0036: a pasted posting's importer, and a source's new roles by day.
    index("jobs_added_by_idx").on(t.addedBy).where(sql`${t.addedBy} is not null`),
    index("jobs_source_first_seen_idx").on(t.sourceId, t.firstSeenAt),
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
    /**
     * Fingerprint of everything the last A5 score was computed from (the role, this account's
     * profile and evidence, and the model). Unchanged inputs mean the stored score still stands,
     * so the call is skipped. Null means "never scored, or scored before this column existed".
     */
    scoreInputHash: text("score_input_hash"),
    /**
     * What happened to the last score attempt, so a blank score can say which of its five causes
     * it is. Null means "nothing recorded yet", which is how every row that predates the column
     * reads; the interface falls back to the score itself, exactly as R-9.6 requires.
     */
    scoreState: text("score_state", { enum: SCORE_STATES }).$type<ScoreState>(),
    /** When `scoreState` was last set. A `queued` state older than the task deadline is stale. */
    scoreStateAt: ts("score_state_at"),
    /**
     * When the last scoring of this view completed. Beside a null `fitScore` it means the model was
     * asked and gave no usable answer, so a scan does not queue the same inputs again every day.
     */
    scoredAt: ts("scored_at"),
    hidden: boolean("hidden").notNull().default(false),
    /** True when the row was created for a posting the scan had already seen (day-one of a subscription). */
    seeded: boolean("seeded").notNull().default(false),
    archivedAt: ts("archived_at"),
    /**
     * When the gate put this view away. While `archivedAt` still equals it the archive is the
     * gate's, and the view returns as soon as the gate admits it again; an archive a person made
     * never matches.
     */
    gateArchivedAt: ts("gate_archived_at"),
    /**
     * The account asked for this posting by pasting its URL. The gate treats that like a decision:
     * the view stays in this account's table whatever its keywords say.
     */
    addedByUrl: boolean("added_by_url").notNull().default(false),
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
  (t) => [
    index("job_events_job_idx").on(t.jobId, t.at),
    // A posting's recent events are the shared observations plus the reading account's own; each half has its own index.
    index("job_events_shared_job_at_idx").on(t.jobId, t.at).where(sql`${t.userId} is null`),
    index("job_events_user_job_at_idx").on(t.userId, t.jobId, t.at).where(sql`${t.userId} is not null`),
    // Retention's predicate, word for word, so the planner can prove the prune may use it.
    index("job_events_prunable_at_idx").on(t.at).where(sql`${t.type} in ('updated', 'scored', 'description_fetched')`),
  ],
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
    index("decisions_job_idx").on(t.jobId).where(sql`${t.jobId} is not null`),
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
}, (t) => [index("company_profiles_company_generated_idx").on(t.companyId, t.generatedAt.desc())]);

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
}, (t) => [uniqueIndex("discovery_document_dedupe").on(t.sourceId, t.fingerprint), index("discovery_document_pending_idx").on(t.sourceId, t.createdAt).where(sql`${t.processedAt} is null`),
  index("discovery_documents_processed_idx").on(t.processedAt).where(sql`${t.content} <> ''`)]);

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
  index("company_suggestions_pending_created_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
]);

/**
 * System-wide settings (schedule, models, scan policy): one row per key, edited by an
 * administrator, and read whole on hot paths. A few small worker markers share it under an
 * `internal:` prefix and are read one key at a time; nothing that grows with the number of
 * accounts, roles or sources belongs here.
 */
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
    index("tasks_status_run_after_idx").on(t.status, t.priority, t.runAfter, t.createdAt),
    index("tasks_scan_run_idx").on(sql`(${t.payload}->>'scanRunId')`, t.status),
    index("tasks_source_status_idx").on(sql`(${t.payload}->>'sourceId')`, t.status, t.createdAt),
    index("tasks_lane_idx").on(t.type, t.status, t.priority, t.runAfter, t.createdAt),
    // What a payload is about: a company's scans and discovery, a draft's build, an account's work.
    index("tasks_company_idx").on(sql`(${t.payload}->>'companyId')`, t.type, t.status).where(sql`(${t.payload}->>'companyId') is not null`),
    index("tasks_draft_idx").on(sql`(${t.payload}->>'draftId')`, t.status).where(sql`(${t.payload}->>'draftId') is not null`),
    index("tasks_user_idx").on(sql`(${t.payload}->>'userId')`, t.type, t.createdAt).where(sql`(${t.payload}->>'userId') is not null`),
    // Retention and the failed-task list.
    index("tasks_status_finished_idx").on(t.status, t.finishedAt),
    // At most one task per key that is queued and has never started. A running task does not absorb
    // an enqueue, so work asked for while it runs gets one follow-up that reads the state by then;
    // a started task handed back to the queue keeps `started_at`, so it never collides with that
    // follow-up. CV builds keep one task per draft, queued or running: the draft allows one build
    // at a time, and the interface refuses a rebuild while the last task is still finishing. The
    // plain index answers "is anything queued or running for this key".
    uniqueIndex("tasks_dedupe_queued_uidx").on(t.dedupeKey).where(sql`${t.status} = 'queued' and ${t.startedAt} is null and ${t.type} <> 'generate_cv' and ${t.dedupeKey} is not null`),
    uniqueIndex("tasks_dedupe_cv_build_uidx").on(t.dedupeKey).where(sql`${t.type} = 'generate_cv' and ${t.status} in ('queued', 'running') and ${t.dedupeKey} is not null`),
    index("tasks_dedupe_active_idx").on(t.dedupeKey).where(sql`${t.status} in ('queued', 'running') and ${t.dedupeKey} is not null`),
    // How many CV builds an account has running, which the claim orders CV builds by (0041).
    index("tasks_cv_running_user_idx").on(sql`(${t.payload}->>'userId')`).where(sql`${t.type} = 'generate_cv' and ${t.status} = 'running'`),
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
    /** Which step of a multi-call feature this was (a CV build: rubric, planning, author, improvement, review, review_candidate, and their `_retry`), so a build's cost can be explained, not only summed. */
    stage: text("stage"),
    /** The prompt registry entry that produced the call (`packages/ai/src/prompt-registry.ts`), and the short hash of its prompt text and schema. */
    promptId: text("prompt_id"),
    promptVersion: text("prompt_version"),
    /** Milliseconds from sending the request to the first stream event: the wait the person feels before anything happens. */
    ttftMs: integer("ttft_ms"),
    /** The longest silence between two stream events, which is what the idle timeout measures. */
    maxEventGapMs: integer("max_event_gap_ms"),
    /** The provider's `stop_reason` for an answered call; null for one that never got an answer. */
    stopReason: text("stop_reason"),
    /** The provider's request id, for a support ticket about one call. */
    requestId: text("request_id"),
    /** How many times the request was sent: 1 unless the engine retried a rate limit, overload or dropped connection. */
    attempt: integer("attempt"),
    /** The build step (or other caller step) this call belongs to, so a step's calls can be listed with it. */
    stepId: text("step_id"),
    at: tsNow("at"),
  },
  (t) => [
    index("ai_calls_at_idx").on(t.at),
    index("ai_calls_user_at_idx").on(t.userId, t.at),
    index("ai_calls_site_at_idx").on(t.callSite, t.at),
    // Created by migration 0038: the cost-per-build sample, by draft within the last ninety days.
    index("ai_calls_cv_ref_at_idx").on(t.refId, t.at).where(sql`${t.refType} like 'cv-%' and ${t.refId} is not null`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthAccount = typeof authAccounts.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuthToken = typeof authTokens.$inferSelect;
export type UserSetting = typeof userSettings.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type CompanyLogo = typeof companyLogos.$inferSelect;
export type CompanyNameSuggestion = typeof companyNameSuggestions.$inferSelect;
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
export type JobOrigin = (typeof JOB_ORIGINS)[number];
export type NameSuggestionStatus = (typeof NAME_SUGGESTION_STATUSES)[number];


export const cvLibraries = pgTable("cv_libraries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  content: jsonb("content").$type<CvLibrary>().notNull(),
  createdAt: tsNow("created_at"),
}, t => [uniqueIndex("cv_libraries_user_version_uidx").on(t.userId, t.version)]);

/** How much evidence an entry carries. Mirrors `EVIDENCE_RATINGS` in @ava/core. */
export const EVIDENCE_RATINGS = ["none", "weak", "good", "strong"] as const;
export type EvidenceRating = (typeof EVIDENCE_RATINGS)[number];
/**
 * Who produced a review. `rules` is the deterministic baseline computed from the person's own
 * facet tags, written the moment a library is saved; `model` is the A12 review, which lands when
 * the task has run. Mirrors `LIBRARY_REVIEW_SOURCES` in @ava/core.
 */
export const LIBRARY_REVIEW_SOURCES = ["rules", "model"] as const;
export type LibraryReviewSource = (typeof LIBRARY_REVIEW_SOURCES)[number];

/**
 * The evidence review of one library entry: what each row was classified as, which facets are
 * covered, what to ask for next, and the score code computed from all of it.
 *
 * It is a separate table rather than a column on `cv_libraries` because a library version is
 * immutable and a review is not part of what the person wrote: the review arrives after the save,
 * can be recomputed, and is derived rather than authored. `input_hash` is what makes that cheap —
 * it covers the entry's rows, its facets and the job it belongs to, so a typo fix re-reviews one
 * entry and every unchanged entry carries its review forward to the new version untouched.
 *
 * A score here gates nothing. It informs the person, exactly as the fit score ranks a role
 * without ever removing it from the table.
 */
export const cvLibraryReviews = pgTable("cv_library_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  libraryVersion: integer("library_version").notNull(),
  entryId: text("entry_id").notNull(),
  /** Fingerprint of everything the review was computed from; see `libraryEntryInputHash` in core. */
  inputHash: text("input_hash").notNull(),
  score: integer("score").notNull(),
  rating: text("rating", { enum: EVIDENCE_RATINGS }).$type<EvidenceRating>().notNull(),
  source: text("source", { enum: LIBRARY_REVIEW_SOURCES }).$type<LibraryReviewSource>().notNull(),
  review: jsonb("review").$type<LibraryEntryReview>().notNull(),
  /** The model that produced a `model` review; null for the rules baseline. */
  model: text("model"),
  createdAt: tsNow("created_at"),
}, t => [
  uniqueIndex("cv_library_reviews_version_entry_uidx").on(t.userId, t.libraryVersion, t.entryId),
  index("cv_library_reviews_entry_idx").on(t.userId, t.entryId, t.createdAt.desc()),
]);
export type CvLibraryReview = typeof cvLibraryReviews.$inferSelect;
export type NewCvLibraryReview = typeof cvLibraryReviews.$inferInsert;

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
  status: text("status", { enum: ["queued", "generating", "awaiting_evidence", "ready", "failed"] }).notNull().default("queued"),
  buildStage: text("build_stage", { enum: ["analysing", "writing", "fitting", "assessing"] }),
  /** Last moment the build advanced (a stage change, a batch finishing). Stale while `generating` means the worker stopped, not that the model is slow. */
  progressAt: ts("progress_at"),
  /** What this build has already paid for, so a retry resumes rather than starting over. */
  buildCheckpoint: jsonb("build_checkpoint").$type<CvBuildCheckpoint>(),
  /** Why the last attempt stopped and whose move it is; cleared when a build starts afresh. */
  failure: jsonb("failure").$type<CvBuildFailure>(),
  /** Optional factual questions raised after role analysis, including their immutable resolution. */
  gapQuiz: jsonb("gap_quiz").$type<CvGapQuiz>(),
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
  // The job's side of `on delete set null`, and the per-role "does this account hold a CV" probe.
  index("cv_drafts_job_user_idx").on(table.jobId, table.userId).where(sql`${table.jobId} is not null`),
]);

/**
 * The evidence plan a published CV's wording was written against, kept beside its assessment so
 * the build can be replayed and explained after its checkpoint has been cleared. A table of its
 * own rather than a column: the interface selects every column of `cv_drafts`, and deploys apart
 * from the worker that migrates.
 */
export const cvTailoringPlans = pgTable("cv_tailoring_plans", {
  // No foreign keys (see 0041): a delete trigger on cv_drafts removes a draft's plan with it.
  draftId: uuid("draft_id").primaryKey(),
  userId: uuid("user_id").notNull(),
  plan: jsonb("plan").$type<CvTailoringPlan>().notNull(),
  createdAt: tsNow("created_at"),
}, table => [index("cv_tailoring_plans_user_idx").on(table.userId)]);

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
  /** The shared posting this is an application for: what ties the row to the account's role stage. */
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  jobTitle: text("job_title").notNull(),
  companyName: text("company_name").notNull(),
  appliedOn: text("applied_on").notNull(),
  /** Null when the stage was set from the roles table and no CV was submitted through us. */
  pdfBase64: text("pdf_base64"),
  status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("applied"),
  notes: text("notes").notNull().default(""),
  /** What the person owes this application next, in their own words. The interface caps it at 200 characters. */
  nextAction: text("next_action"),
  /** The day that next action is due, as YYYY-MM-DD. A day, not an instant: "Tuesday" is not a timestamp. */
  nextActionOn: text("next_action_on"),
  /**
   * One entry per recorded stage change. `at` is when it was saved; `on` is the day the entry is
   * *about* — an interview date, a rejection date — which is the thing people actually track and
   * which the save time cannot express. Optional, because every entry written before it existed
   * has only its save time.
   */
  history: jsonb("history").$type<Array<{ status: string; at: string; notes: string; on?: string }>>().notNull(),
  createdAt: tsNow("created_at"),
}, t => [
  index("applications_user_idx").on(t.userId, t.appliedOn),
  index("applications_user_job_idx").on(t.userId, t.jobId),
  index("applications_job_idx").on(t.jobId).where(sql`${t.jobId} is not null`),
  index("applications_cv_idx").on(t.cvId).where(sql`${t.cvId} is not null`),
]);

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
}, t => [uniqueIndex("discovery_candidate_document_domain").on(t.documentId, t.domain), uniqueIndex("discovery_candidate_batch_domain").on(t.batchKey, t.domain),
  index("discovery_candidates_user_idx").on(t.userId)]);

export const verificationCache = pgTable("verification_cache", {
  key: text("key").primaryKey(),
  result: jsonb("result").$type<NonNullable<typeof companySuggestions.$inferSelect.verification>>().notNull(),
  expiresAt: ts("expires_at").notNull(),
}, (t) => [index("verification_cache_expires_idx").on(t.expiresAt)]);

export const hostPacing = pgTable("host_pacing", {
  host: text("host").primaryKey(),
  nextAt: ts("next_at").notNull(),
});

/**
 * Sparse-feed admission: the fingerprints of postings whose description was fetched and rejected,
 * per careers source, so the same detail page is not fetched again every day. Bounded (10,000 per
 * source, entries expire after seven days) and rewritten on each scan. Nothing here is user data:
 * a fingerprint covers the listing metadata and the gate it was judged against, so a changed gate
 * simply misses and the detail is fetched again. It goes with the source it belongs to.
 */
export const sourceAdmissionRejections = pgTable("source_admission_rejections", {
  sourceId: uuid("source_id").primaryKey().references(() => careerSources.id, { onDelete: "cascade" }),
  /** fingerprint → epoch milliseconds of the rejection. */
  fingerprints: jsonb("fingerprints").$type<Record<string, number>>().notNull(),
  updatedAt: tsNow("updated_at"),
});

export const aiReservations = pgTable("ai_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Whose budget this hold is against; null for work no account asked for (extraction, discovery). */
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  callSite: text("call_site").notNull(),
  amount: real("amount").notNull(),
  createdAt: tsNow("created_at"),
  expiresAt: ts("expires_at").notNull(),
  /** The worker process holding this reservation, so a shutdown can release its own holds at once. */
  workerId: text("worker_id"),
  /**
   * What the hold is for: a CV build's draft id. An account can hold two builds at once, so a
   * release scoped to the account alone gave back a sibling's hold as well — its renewal then
   * updated nothing and the budget admitted a third build the month could not afford.
   */
  refId: text("ref_id"),
}, (t) => [index("ai_reservations_user_idx").on(t.userId), index("ai_reservations_worker_idx").on(t.workerId),
  index("ai_reservations_ref_idx").on(t.refId), index("ai_reservations_expires_idx").on(t.expiresAt)]);

export const WORKER_EVENT_KINDS = [
  "boot", "shutdown", "crash_recovery", "task_abandoned", "task_deadline", "holds_released", "vitals",
] as const;
export type WorkerEventKind = (typeof WORKER_EVENT_KINDS)[number];

/**
 * What the worker process did that a log line alone would lose: boots and their memory ceiling,
 * crash recoveries with the tasks that were running when the previous process died, tasks given
 * up on, holds released. Operations reads it to say whether the worker is healthy and, when it is
 * not, which task is implicated. Pruned after thirty days.
 */
export const workerEvents = pgTable("worker_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: tsNow("at"),
  workerId: text("worker_id").notNull(),
  kind: text("kind", { enum: WORKER_EVENT_KINDS }).notNull(),
  taskId: uuid("task_id"),
  taskType: text("task_type"),
  userId: uuid("user_id"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [index("worker_events_at_idx").on(t.at), index("worker_events_kind_at_idx").on(t.kind, t.at)]);

export const HTTP_VIAS = ["http", "browser"] as const;
export type HttpVia = (typeof HTTP_VIAS)[number];

/**
 * Outbound traffic per logical host per day, kept by the fetcher and the browser as counters and
 * flushed in batches. This is the record that says whether a vendor is throttling us, how many
 * requests and bytes a board costs, and how often revalidation spares a transfer: the per-request
 * log line answers none of that once the platform has dropped it. Latency buckets are the upper
 * bounds 0.5 s, 1 s, 2 s, 5 s, 15 s and beyond, in that order.
 */
export const httpHostDaily = pgTable("http_host_daily", {
  day: text("day").notNull(),
  host: text("host").notNull(),
  via: text("via", { enum: HTTP_VIAS }).notNull(),
  requests: integer("requests").notNull().default(0),
  bytesIn: bigint("bytes_in", { mode: "number" }).notNull().default(0),
  ok2xx: integer("ok_2xx").notNull().default(0),
  notModified304: integer("not_modified_304").notNull().default(0),
  redirects3xx: integer("redirects_3xx").notNull().default(0),
  client4xx: integer("client_4xx").notNull().default(0),
  server5xx: integer("server_5xx").notNull().default(0),
  rateLimited: integer("rate_limited").notNull().default(0),
  blocked: integer("blocked").notNull().default(0),
  robotsDenied: integer("robots_denied").notNull().default(0),
  capRejected: integer("cap_rejected").notNull().default(0),
  timeouts: integer("timeouts").notNull().default(0),
  networkErrors: integer("network_errors").notNull().default(0),
  durationMsSum: bigint("duration_ms_sum", { mode: "number" }).notNull().default(0),
  durationMsMax: integer("duration_ms_max").notNull().default(0),
  latencyBuckets: integer("latency_buckets").array().notNull().default(sql`'{0,0,0,0,0,0}'::integer[]`),
}, (t) => [primaryKey({ columns: [t.day, t.host, t.via] }), index("http_host_daily_day_idx").on(t.day)]);

/**
 * One row per motion of a CV build: what it was doing, when, for how long, with what result.
 * The CV page reads them as the build's narrative while it runs and afterwards; Operations reads
 * them by motion to see where builds spend their time and where they fail. Rows go with the draft.
 */
export const cvBuildSteps = pgTable("cv_build_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  draftId: uuid("draft_id").notNull().references(() => cvDrafts.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  taskId: uuid("task_id"),
  attempt: integer("attempt").notNull().default(1),
  seq: integer("seq").notNull(),
  stage: text("stage").$type<CvBuildStage>().notNull(),
  motion: text("motion").$type<CvBuildMotion>().notNull(),
  title: text("title").notNull(),
  status: text("status").$type<CvBuildStepStatus>().notNull().default("running"),
  startedAt: tsNow("started_at"),
  finishedAt: ts("finished_at"),
  ms: integer("ms"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  error: text("error"),
  failure: jsonb("failure").$type<CvBuildFailure>(),
  // One row per place in a draft's narrative: `seq` is allocated under an advisory lock on the
  // draft, and this is what makes two attempts unable to claim the same place regardless.
}, (t) => [uniqueIndex("cv_build_steps_draft_seq_uniq").on(t.draftId, t.seq), index("cv_build_steps_started_idx").on(t.startedAt)]);
export type CvBuildStep = typeof cvBuildSteps.$inferSelect;

// ---------------------------------------------------------------------------
// Documents imported into the Library, and CV previews shared for comment
// ---------------------------------------------------------------------------

/** Postgres `bytea`, which drizzle has no column builder for. The pg driver reads and writes it as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const LIBRARY_IMPORT_KINDS = ["cv", "linkedin", "website", "paste"] as const;
export type LibraryImportKind = (typeof LIBRARY_IMPORT_KINDS)[number];

/** The most extracted text one import keeps; the column's check constraint repeats the number. */
export const LIBRARY_IMPORT_MAX_CHARS = 40_000;
/** The largest upload an import may carry, in bytes; the column's check constraint repeats the number. */
export const LIBRARY_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * One document a person brought to the Library: a past CV, LinkedIn's own PDF of their profile,
 * their personal website, or text they pasted.
 *
 * The row is the whole of an import's life. An upload arrives as `source_bytes`, because the
 * conversion belongs in the worker, which already owns every parser; the worker converts it,
 * writes the text into `content` and clears the bytes, so nothing binary outlives the conversion.
 * A paste arrives with its `content` already. A website arrives as a `url` and is fetched
 * politely, because it is the person's own site — the product never crawls LinkedIn for this, and
 * asks for LinkedIn's own PDF instead.
 *
 * `fingerprint` is what stops the same document being imported twice: sha256 of the bytes for an
 * upload, of the stored text for a paste, of the normalised URL for a website, unique per account.
 * A second attempt reads the first import back rather than making another.
 *
 * `proposal` is deliberately untyped jsonb here: what the extraction proposes is the engine's
 * schema, validated where it is produced, and the database is not the place for a second copy of
 * it. It is only ever a proposal — every item is accepted or dismissed by the person before
 * anything reaches the Library, which is what `resolved_at` records, and what takes an import off
 * the Library page.
 */
export const libraryImports = pgTable("library_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: LIBRARY_IMPORT_KINDS }).$type<LibraryImportKind>().notNull(),
  /** What the upload was called, so the person recognises it. Null for a paste or a website. */
  filename: text("filename"),
  /** The person's own site, for a `website` import; null otherwise. */
  url: text("url"),
  /** The extracted text, capped at `LIBRARY_IMPORT_MAX_CHARS`. Null until the worker has converted an upload or fetched a page. */
  content: text("content"),
  /** The uploaded PDF or DOCX, capped at `LIBRARY_IMPORT_MAX_BYTES`, kept only until the worker has converted it. */
  sourceBytes: bytea("source_bytes"),
  /** The upload's media type, so the worker knows which parser to use. Cleared with the bytes. */
  sourceMime: text("source_mime"),
  fingerprint: text("fingerprint").notNull(),
  proposal: jsonb("proposal").$type<unknown>(),
  error: text("error"),
  /** When the worker finished with it, whether it produced a proposal or an error. */
  processedAt: ts("processed_at"),
  /** When the person accepted or dismissed the proposal, which is what takes the import off the page. */
  resolvedAt: ts("resolved_at"),
  createdAt: tsNow("created_at"),
}, t => [
  index("library_imports_user_idx").on(t.userId, t.createdAt.desc()),
  uniqueIndex("library_imports_user_fingerprint_uidx").on(t.userId, t.fingerprint),
]);
export type LibraryImport = typeof libraryImports.$inferSelect;
export type NewLibraryImport = typeof libraryImports.$inferInsert;

/**
 * A link that shows one CV preview to someone the person chose, for as long as they choose.
 *
 * Modelled on `auth_tokens`: only a hash of the token is stored, so the link sitting in a
 * reviewer's inbox cannot be recovered from the database. It differs in being multi-use — a
 * reviewer opens it as often as they like — which is why it carries `revoked_at`, `expires_at`
 * and a view count rather than `used_at`: the owner can see that it was read and can end it at
 * any moment.
 *
 * The row is also how "never read per-account data without a `userId`" survives a route with no
 * session. The owner's `user_id` is on the share, so a token lookup yields the account the read
 * must be scoped by, and the reader gets one revision of one document and no reach into anything
 * else in the account.
 */
export const cvShares = pgTable("cv_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The owner: the account every read made through this link is scoped by. */
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  draftId: uuid("draft_id").notNull().references(() => cvDrafts.id, { onDelete: "cascade" }),
  /** sha256 of the token in the link. The token itself is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  allowComments: boolean("allow_comments").notNull().default(true),
  expiresAt: ts("expires_at").notNull(),
  revokedAt: ts("revoked_at"),
  viewCount: integer("view_count").notNull().default(0),
  lastViewedAt: ts("last_viewed_at"),
  createdAt: tsNow("created_at"),
}, t => [index("cv_shares_user_draft_idx").on(t.userId, t.draftId), index("cv_shares_draft_idx").on(t.draftId)]);
export type CvShare = typeof cvShares.$inferSelect;
export type NewCvShare = typeof cvShares.$inferInsert;

/** The longest anchor, name and note a comment may carry; the column check constraints repeat the numbers. */
export const CV_SHARE_ANCHOR_MAX_CHARS = 120;
export const CV_SHARE_AUTHOR_NAME_MAX_CHARS = 80;
export const CV_SHARE_BODY_MAX_CHARS = 2_000;

/**
 * A note a reader left against one block of a shared CV.
 *
 * `anchor` is an id the assessment already cites — the profile block, or a section block — so a
 * reader's note and the reviewer's finding sit beside the same text. `user_id` is the owner's,
 * denormalised from the share, so that every read of a comment is scoped by account without
 * depending on anyone remembering the join.
 *
 * Nothing written here reaches a model call unless the owner copies it there themselves: a
 * comment is data, exactly as an imported document is, never an instruction.
 */
export const cvShareComments = pgTable("cv_share_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  shareId: uuid("share_id").notNull().references(() => cvShares.id, { onDelete: "cascade" }),
  /** The owner of the CV, copied from the share; never the reader, who has no account. */
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  /** The block the note is about: free text here, an assessment anchor in practice. */
  anchor: text("anchor").notNull(),
  /** What the reader called themselves. Unverified, and shown as such. */
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  createdAt: tsNow("created_at"),
  /** When the owner marked the note dealt with. Null while it is still open. */
  resolvedAt: ts("resolved_at"),
}, t => [
  index("cv_share_comments_share_idx").on(t.shareId, t.createdAt),
  index("cv_share_comments_user_open_idx").on(t.userId, t.resolvedAt),
]);
export type CvShareComment = typeof cvShareComments.$inferSelect;
export type NewCvShareComment = typeof cvShareComments.$inferInsert;
