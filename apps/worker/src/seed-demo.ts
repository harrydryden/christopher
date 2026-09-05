/**
 * Seed the database with realistic demo data so the interface can be exercised without waiting
 * for a real scan. Safe to re-run: it clears its own rows first.
 *
 *   DATABASE_URL=... pnpm --filter @christopher/worker exec tsx src/seed-demo.ts
 */
import { createDb, runMigrations, schema } from "@christopher/db";
import { evaluateGate, normalizeTitle, DEFAULT_SETTINGS } from "@christopher/core";
import { sql } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { db, pool } = createDb(url, { max: 1 });
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

const GATE = { ...DEFAULT_SETTINGS.gate, includeKeywords: ["operations", "ops", '"chief of staff"'], excludeKeywords: ["intern"], locationTerms: ["London", "UK"] };

interface DemoJob {
  title: string;
  location: string;
  department: string;
  postedDaysAgo: number | null;
  firstSeenDaysAgo: number;
  closedDaysAgo?: number;
  remote?: boolean;
  fitScore?: number;
  fitRationale?: string;
  decision?: { decision: "apply" | "skip"; reason: string; tags: string[] };
  salaryText?: string;
}

const COMPANIES: Array<{
  name: string;
  homepageUrl: string;
  domain: string;
  source: { type: "greenhouse" | "lever" | "ashby" | "html"; slug?: string; url: string; confidence: number; method: string };
  profile?: { oneLiner: string; sector: string; stage: string; sizeBand: string; hqCountry: string; tags: string[] };
  jobs: DemoJob[];
}> = [
  {
    name: "Northwind Robotics",
    homepageUrl: "https://www.northwind-robotics.example/",
    domain: "northwind-robotics.example",
    source: { type: "greenhouse", slug: "northwind", url: "https://job-boards.greenhouse.io/northwind", confidence: 0.95, method: "ats_link" },
    profile: { oneLiner: "Warehouse automation robots for third-party logistics providers.", sector: "Robotics", stage: "series-c", sizeBand: "201-500", hqCountry: "United Kingdom", tags: ["robotics", "logistics", "b2b"] },
    jobs: [
      { title: "Head of Operations", location: "London, UK", department: "Operations", postedDaysAgo: 2, firstSeenDaysAgo: 2, fitScore: 88, fitRationale: "Operations leadership at a scale-up in London, which matches your target band and location.", salaryText: "£95,000 - £115,000" },
      { title: "Operations Manager, Fulfilment", location: "Manchester, UK", department: "Operations", postedDaysAgo: 5, firstSeenDaysAgo: 5, fitScore: 61, fitRationale: "Right function and seniority, but Manchester is outside the area you have applied in so far." },
      { title: "Senior Software Engineer", location: "London, UK", department: "Engineering", postedDaysAgo: 3, firstSeenDaysAgo: 3 },
      { title: "Operations Intern", location: "London, UK", department: "Operations", postedDaysAgo: 1, firstSeenDaysAgo: 1 },
      { title: "Chief of Staff", location: "London, UK", department: "Executive", postedDaysAgo: 12, firstSeenDaysAgo: 12, fitScore: 79, fitRationale: "Chief of Staff at a company under 300 people, which your profile puts in scope.", decision: { decision: "apply", reason: "Reports to the COO and the remit includes process design, which is what I want next.", tags: ["domain:interested"] } },
      { title: "Operations Coordinator", location: "London, UK", department: "Operations", postedDaysAgo: 40, firstSeenDaysAgo: 40, closedDaysAgo: 3, fitScore: 22, fitRationale: "Coordinator level sits below the band you have been applying in.", decision: { decision: "skip", reason: "Too junior. I am looking at Head of and Senior Manager level.", tags: ["seniority:too_junior"] } },
    ],
  },
  {
    name: "Meridian Climate",
    homepageUrl: "https://www.meridianclimate.example/",
    domain: "meridianclimate.example",
    source: { type: "ashby", slug: "meridian", url: "https://jobs.ashbyhq.com/meridian", confidence: 0.97, method: "ats_network" },
    profile: { oneLiner: "Carbon measurement and reporting software for mid-market manufacturers.", sector: "Climate software", stage: "series-a", sizeBand: "51-200", hqCountry: "United Kingdom", tags: ["climate", "b2b", "saas"] },
    jobs: [
      { title: "Business Operations Lead", location: "Remote - UK", department: "Operations", postedDaysAgo: 1, firstSeenDaysAgo: 1, remote: true, fitScore: 84, fitRationale: "Business operations at Series A, remote in the UK, and climate is a sector you marked as preferred.", salaryText: "£80,000 - £95,000" },
      { title: "Operations Analyst", location: "London, UK", department: "Operations", postedDaysAgo: null, firstSeenDaysAgo: 9, fitScore: 44, fitRationale: "Analyst title is below your band, though the company profile fits well." },
      { title: "Account Executive", location: "Remote - USA", department: "Sales", postedDaysAgo: 4, firstSeenDaysAgo: 4, remote: true },
    ],
  },
  {
    name: "Halcyon Health",
    homepageUrl: "https://www.halcyonhealth.example/",
    domain: "halcyonhealth.example",
    source: { type: "html", url: "https://www.halcyonhealth.example/careers", confidence: 0.85, method: "listing_jsonld" },
    profile: { oneLiner: "Community diagnostics clinics run under NHS contracts.", sector: "Healthcare services", stage: "growth", sizeBand: "501-1000", hqCountry: "United Kingdom", tags: ["healthcare", "operations-heavy"] },
    jobs: [
      { title: "Regional Operations Director", location: "London, UK", department: "Operations", postedDaysAgo: null, firstSeenDaysAgo: 21, fitScore: 71, fitRationale: "Operations leadership in London, though a 900-person organisation is larger than the companies you have chosen so far." },
      { title: "Clinic Operations Manager", location: "Reading, UK", department: "Operations", postedDaysAgo: null, firstSeenDaysAgo: 30, fitScore: 35, fitRationale: "Shift-based clinic operations, which your profile lists as a deal-breaker.", decision: { decision: "skip", reason: "Shift-based site operations, not the kind of ops work I mean.", tags: ["role_type:not_operations"] } },
    ],
  },
];

async function main() {
  await runMigrations(db);
  await db.execute(sql`truncate companies, career_sources, discovery_runs, scan_runs, scans, jobs, job_events, decisions, company_profiles, company_suggestions, filter_suggestions, preference_profiles, tasks, ai_calls restart identity cascade`);

  await db.insert(schema.settings).values([
    { key: "gate", value: GATE },
    { key: "seedProfile", value: "Operations leadership roles, Head of Operations to Senior Operations Manager, in London or UK-remote. Prefer B2B software, climate and healthcare operations at Series A to C. No relocation, no shift work." },
    { key: "timezone", value: "Europe/London" },
  ]).onConflictDoUpdate({ target: schema.settings.key, set: { value: sql`excluded.value` } });

  const [scanRun] = await db
    .insert(schema.scanRuns)
    .values({ runDate: now.toISOString().slice(0, 10), trigger: "schedule", companiesTotal: COMPANIES.length, companiesOk: COMPANIES.length, companiesFailed: 0, newRoles: 3, closedRoles: 1, finishedAt: now })
    .returning({ id: schema.scanRuns.id });

  const companyIds: Record<string, string> = {};

  for (const spec of COMPANIES) {
    const [company] = await db.insert(schema.companies).values({ name: spec.name, homepageUrl: spec.homepageUrl, domain: spec.domain, addedAt: daysAgo(45) }).returning();
    companyIds[spec.name] = company!.id;

    const [source] = await db
      .insert(schema.careerSources)
      .values({
        companyId: company!.id,
        type: spec.source.type,
        url: spec.source.url,
        apiUrl: spec.source.slug ? `https://api.example/${spec.source.slug}` : null,
        atsSlug: spec.source.slug ?? null,
        discoveryMethod: spec.source.method,
        confidence: spec.source.confidence,
        confirmedByUser: false,
        status: "active",
        lastOkScanAt: now,
        lastPostingsCount: spec.jobs.length,
        verifiedAt: daysAgo(45),
      })
      .returning();

    await db.insert(schema.discoveryRuns).values({
      companyId: company!.id,
      status: "resolved",
      startedAt: daysAgo(45),
      finishedAt: daysAgo(45),
      chosenSourceId: source!.id,
      candidates: [],
      log: [`homepage ${spec.homepageUrl}`, `best: ${spec.source.type} at ${spec.source.confidence} (${spec.source.method}) -> resolved`],
    });

    await db.insert(schema.scans).values({
      scanRunId: scanRun!.id,
      sourceId: source!.id,
      startedAt: now,
      finishedAt: now,
      status: "ok",
      fetchMethod: spec.source.type === "html" ? "http" : "api",
      postingsFound: spec.jobs.length,
      newCount: spec.jobs.filter((j) => j.firstSeenDaysAgo <= 1).length,
      closedCount: spec.jobs.filter((j) => j.closedDaysAgo !== undefined).length,
      durationMs: 900,
    });

    if (spec.profile) {
      await db.insert(schema.companyProfiles).values({
        companyId: company!.id,
        name: spec.name,
        domain: spec.domain,
        oneLiner: spec.profile.oneLiner,
        sector: spec.profile.sector,
        stage: spec.profile.stage,
        sizeBand: spec.profile.sizeBand,
        hqCountry: spec.profile.hqCountry,
        geographies: ["United Kingdom"],
        tags: spec.profile.tags,
      });
    }

    for (const job of spec.jobs) {
      const gate = evaluateGate({ title: job.title, department: job.department, location: job.location, remote: job.remote }, GATE);
      const slug = job.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const [created] = await db
        .insert(schema.jobs)
        .values({
          companyId: company!.id,
          sourceId: source!.id,
          externalKey: `id:${spec.domain}-${slug}`,
          title: job.title,
          normalizedTitle: normalizeTitle(job.title),
          url: `${spec.source.url}/jobs/${slug}`,
          location: job.location,
          locations: [job.location],
          department: job.department,
          employmentType: "Full-time",
          remote: job.remote ?? gate.remote,
          salaryText: job.salaryText ?? null,
          postedAt: job.postedDaysAgo === null ? null : daysAgo(job.postedDaysAgo),
          firstSeenAt: daysAgo(job.firstSeenDaysAgo),
          lastSeenAt: job.closedDaysAgo === undefined ? now : daysAgo(job.closedDaysAgo),
          closedAt: job.closedDaysAgo === undefined ? null : daysAgo(job.closedDaysAgo),
          status: job.closedDaysAgo === undefined ? "open" : "closed",
          descriptionText: `${job.title} at ${spec.name}. ${spec.profile?.oneLiner ?? ""}\n\nYou will own day-to-day operations, design the processes the team runs on, and work directly with the leadership team.`,
          keywordMatched: gate.keywordMatched,
          keywordTerms: gate.keywordTerms,
          excluded: gate.excluded,
          locationOk: gate.locationOk,
          inTable: gate.inTable,
          nearMiss: !gate.inTable && !gate.excluded && /operations|ops/i.test(job.department),
          fitScore: job.fitScore ?? null,
          fitVerdict: job.fitScore === undefined ? null : job.fitScore >= 70 ? "strong" : job.fitScore >= 30 ? "possible" : "unlikely",
          fitRationale: job.fitRationale ?? null,
          fitScoredAt: job.fitScore === undefined ? null : now,
        })
        .returning();

      await db.insert(schema.jobEvents).values({ jobId: created!.id, type: "discovered", payload: { method: "api" }, at: daysAgo(job.firstSeenDaysAgo) });
      if (job.closedDaysAgo !== undefined) {
        await db.insert(schema.jobEvents).values({ jobId: created!.id, type: "closed", payload: {}, at: daysAgo(job.closedDaysAgo) });
      }
      if (job.decision) {
        await db.insert(schema.decisions).values({
          jobId: created!.id,
          decision: job.decision.decision,
          reason: job.decision.reason,
          tags: job.decision.tags,
          jobTitle: job.title,
          companyName: spec.name,
          jobLocation: job.location,
          jobDepartment: job.department,
          descriptionSnippet: `${job.title} at ${spec.name}.`,
          fitScoreAtDecision: job.fitScore ?? null,
          createdAt: daysAgo(Math.max(0, job.firstSeenDaysAgo - 1)),
        });
        await db.insert(schema.jobEvents).values({ jobId: created!.id, type: "decided", payload: { decision: job.decision.decision } });
      }
    }
  }

  await db.insert(schema.preferenceProfiles).values({
    version: 3,
    markdown: `## Target roles
Operations leadership from Head of Operations to Senior Operations Manager. Chief of Staff is in scope at companies under about 300 people. [pinned]

## Seniority
Skip Coordinator, Associate, Analyst and Intern titles (2 skips). No evidence yet on VP or director level at large companies.

## Location
London, or fully remote within the UK. No relocation. [pinned]

## Sectors and companies
Prefer B2B software, climate and healthcare operations at Series A to C. Avoid shift-based site operations (1 skip).

## Deal-breakers
Shift work. Roles that are operations in name but are customer support management.

## Positive signals
A remit that includes process design and hiring; reporting to a founder or COO; scale-up stage.`,
    pinnedStatements: [
      "Operations leadership from Head of Operations to Senior Operations Manager. Chief of Staff is in scope at companies under about 300 people.",
      "London, or fully remote within the UK. No relocation.",
    ],
    openQuestions: [{ id: "q-large-orgs", question: "Halcyon Health has about 900 people and scored 71. Are organisations over 500 people in scope, or should they be down-weighted?" }],
    sourceDecisionCount: 3,
    model: "claude-opus-5",
  });

  await db.insert(schema.filterSuggestions).values([
    { type: "keyword_exclude", value: { term: "intern" }, rationale: "Two internship postings matched your keywords and neither is at your level.", evidence: ["Operations Intern at Northwind Robotics"], status: "pending" },
    { type: "keyword_include", value: { term: "business operations" }, rationale: "You applied to a Business Operations Lead that only matched through the word operations.", evidence: ["apply: Business Operations Lead at Meridian Climate"], status: "pending" },
  ]);

  await db.insert(schema.companySuggestions).values([
    {
      name: "Verdant Grid",
      homepageUrl: "https://www.verdantgrid.example/",
      domain: "verdantgrid.example",
      rationale: "Climate software at Series A selling to industrial customers, close to Meridian Climate in sector, stage and customer type.",
      similarTo: [companyIds["Meridian Climate"]!].filter(Boolean),
      verification: { homepageOk: true, careersSource: { type: "greenhouse", url: "https://job-boards.greenhouse.io/verdantgrid", confidence: 0.95 }, openRoles: 14, matchingRoles: 2 },
      rank: 0,
      status: "pending",
    },
    {
      name: "Kestrel Logistics Tech",
      homepageUrl: "https://www.kestrellogistics.example/",
      domain: "kestrellogistics.example",
      rationale: "Warehouse software sold to third-party logistics providers, the same customer base as Northwind Robotics.",
      similarTo: [companyIds["Northwind Robotics"]!].filter(Boolean),
      verification: { homepageOk: true, careersSource: { type: "lever", url: "https://jobs.lever.co/kestrel", confidence: 0.95 }, openRoles: 9, matchingRoles: 1 },
      rank: 1,
      status: "pending",
    },
  ]);

  await db.insert(schema.aiCalls).values(
    ["A5", "A5", "A5", "A6", "A7", "A10"].map((callSite, i) => ({
      callSite,
      model: "claude-opus-5",
      inputTokens: 1200 + i * 100,
      outputTokens: 180,
      cacheReadTokens: 3200,
      cacheWriteTokens: i === 0 ? 3200 : 0,
      costUsd: 0.012 + i * 0.004,
      durationMs: 1800,
      ok: true,
      at: daysAgo(i),
    })),
  );

  const counts = await db.execute<{ jobs: number; table: number }>(sql`select count(*)::int as jobs, count(*) filter (where in_table)::int as "table" from jobs`);
  console.log(`seeded ${COMPANIES.length} companies, ${counts.rows[0]?.jobs ?? 0} roles (${counts.rows[0]?.table ?? 0} in the table)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
