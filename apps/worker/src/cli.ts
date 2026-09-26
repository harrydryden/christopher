/**
 * Operational CLI. Run one-off jobs without waiting for the scheduler:
 *   pnpm --filter @ava/worker cli migrate        (apply this checkout's migrations; nothing else does)
 *   pnpm --filter @ava/worker cli probe <url>    (dry run: what would discovery find?)
 *   pnpm --filter @ava/worker cli add <homepage-url>   (follows it as the CLI account)
 *   pnpm --filter @ava/worker cli discover <company-id|domain|name> [careers-url]
 *   pnpm --filter @ava/worker cli discover --all (every active company, never a careers URL)
 *   pnpm --filter @ava/worker cli scan [company-id|domain|name]
 *   pnpm --filter @ava/worker cli drain          (run queued tasks to completion)
 *   pnpm --filter @ava/worker cli list           (companies, sources, followers, counts)
 *   pnpm --filter @ava/worker cli table          (the CLI account's roles table as text)
 *   pnpm --filter @ava/worker cli users          (accounts and roles)
 *   pnpm --filter @ava/worker cli record <draft-id> [--out <file>] [--routes <json>]
 *                                                (a live, paid rebuild of a draft, recorded for replay)
 *   pnpm --filter @ava/worker cli replay <draft-id> [--recordings <file> | --baseline <file>] [--routes <json>] [--out <report.json>]
 *                                                (rebuild and grade a draft without publishing; from a
 *                                                recording without a key, or live with one)
 *
 * Per-account commands act for AVA_CLI_USER (an email) or, when unset, the earliest
 * administrator.
 *
 * Every command except `migrate` first checks that the database is at exactly this checkout's
 * schema and refuses otherwise, so looking at production from a branch never migrates it.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { schema, enqueueTask, reevaluateGate, subscribeToCompany } from "@ava/db";
import { runMigrations } from "@ava/db/migrate";
import {
  dedupeKeyFor,
  discovery,
  displayStatus,
  ensureHttpUrl,
  extractDomain,
  formatDuration,
  liveFor,
  priorityFor,
  renamedEnv,
  sanitiseStageRoutes,
  type StageRoutes,
} from "@ava/core";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { createDeps, makeDiscoveryContext, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { assertSchemaCurrent, discoverTargets, findCompany, schemaState } from "./cli-guards";
import { handlers } from "./handlers";
import { TaskQueue } from "./queue";
import { schedulerTick } from "./scheduler";
import { createProviderClient } from "@ava/ai";
import { readRecordingHeader, recordCvDraft, replayCvDraft, replayFromRecording, type CvReplayReport } from "./cv-replay";

/** `--name value` from the arguments after the command, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

/** `--routes '{"cv.review":{"effort":"medium"}}'`, checked the way the setting is: anything it would drop is refused here. */
function routesFlag(args: string[]): StageRoutes | undefined {
  const raw = flag(args, "routes");
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--routes must be JSON, such as '{"cv.review":{"effort":"medium"}}'`);
  }
  const routes = sanitiseStageRoutes(parsed);
  if (JSON.stringify(routes) !== JSON.stringify(parsed))
    throw new Error(`--routes names a stage, model or effort the stageRoutes setting would not accept; it would keep only ${JSON.stringify(routes)}`);
  return routes;
}

/** Relative paths are the caller's, not the package's: pnpm runs the CLI from apps/worker. */
const fromCaller = (path: string) => resolve(process.env.INIT_CWD ?? process.cwd(), path);

/** Print a replay's outcome, and write its report when asked. */
function reportReplay(report: CvReplayReport, out: string | undefined) {
  const grade = report.grade;
  console.log(`prompt set ${report.promptSetVersion} · ${report.source}${report.unverified ? " (unverified: answers not from the provider)" : ""}`);
  for (const [id, route] of Object.entries(report.routes)) console.log(`  ${id.padEnd(20)} ${route.resolvedModel} at ${route.effort}`);
  console.log(`outcome: ${report.outcome}${report.error ? ` — ${report.error}` : ""}`);
  for (const miss of report.misses) console.log(`  no recording for ${miss.promptId} at version ${miss.promptVersion}${miss.stage ? ` (stage ${miss.stage})` : ""}`);
  console.log(`cost: $${report.costUsd.toFixed(4)} over ${report.calls} call(s), ${(report.wallMs / 1000).toFixed(1)} s`);
  if (grade) {
    console.log(`grade: ${grade.passed ? "PASSED" : "FAILED"} · coverage ${grade.score}${report.baseline ? ` (baseline ${report.baseline.score}, ${report.baseline.source})` : ""} · ${grade.pageCount}/${grade.maxPages} pages`);
    for (const [name, value] of Object.entries(grade.invariants)) console.log(`  ${name}: ${value === null ? "n/a (no baseline)" : value ? "ok" : "FAILED"}`);
    for (const item of grade.regressions) console.log(`  essential ${item.requirementId} fell from ${item.before} to ${item.after ?? "missing"}`);
  }
  if (out) {
    const path = fromCaller(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
    console.log(`report written to ${path}`);
  }
  if (report.outcome !== "published" || !grade?.passed) process.exitCode = 1;
}

async function cliUser(deps: WorkerDeps) {
  const email = renamedEnv(process.env, "AVA_CLI_USER", "CHRISTOPHER_CLI_USER")?.trim().toLowerCase();
  const rows = email
    ? await deps.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    : await deps.db.select().from(schema.users).where(and(eq(schema.users.role, "admin"), sql`${schema.users.claimedAt} is not null`)).orderBy(asc(schema.users.createdAt)).limit(1);
  const user = rows[0];
  if (!user) throw new Error(email ? `no account with email ${email}` : "no administrator account yet; sign up in the interface first");
  return user;
}

const COMMANDS = new Set(["migrate", "probe", "add", "discover", "scan", "tick", "drain", "users", "list", "table", "record", "replay"]);

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !COMMANDS.has(command)) {
    console.log("commands: migrate | probe <url> | add <url...> | discover <company> [url] | discover --all | scan [company] | tick | drain [n] | list | table | users | record <draft> [--out file] [--routes json] | replay <draft> [--recordings file | --baseline file] [--routes json] [--out report.json]");
    return;
  }
  const env = readEnv();
  const deps = await createDeps(env);

  try {
    if (command === "migrate") {
      const before = await schemaState(deps.db);
      await runMigrations(deps.db);
      console.log(before.state === "behind" ? `applied ${before.pending.length} migration(s): ${before.pending.join(", ")}` : "no migrations to apply");
      return;
    }
    await assertSchemaCurrent(deps.db);
    const queue = new TaskQueue(deps, handlers, { concurrency: 1, workerId: "cli" });
    switch (command) {
      case "probe": {
        const target = args[0];
        if (!target) throw new Error("usage: cli probe <url>");
        const ctx = makeDiscoveryContext(deps, { useAi: false });
        const result = target.includes("/") && !/^https?:\/\/[^/]+\/?$/.test(ensureHttpUrl(target))
          ? await discovery.probeUrlAsSource(target, ctx)
          : await discovery.discoverCareersSources(target, ctx);
        console.log(`\n${result.homepageUrl}`);
        console.log(`company: ${result.companyName ?? "(unknown)"}`);
        console.log(`outcome: ${result.outcome}  (${result.fetches} fetches, ${result.durationMs} ms)\n`);
        for (const [i, c] of result.candidates.entries()) {
          console.log(`${i + 1}. ${c.spec.type}${c.spec.atsSlug ? `/${c.spec.atsSlug}` : ""}  ${Math.round(c.confidence * 100)}%  ${c.method}`);
          console.log(`   ${c.spec.url}`);
          if (c.count !== undefined) console.log(`   ${c.count} posting(s)${c.companyName ? `, board name "${c.companyName}"` : ""}`);
          for (const sample of c.sample.slice(0, 3)) console.log(`     - ${sample.title}${sample.location ? ` (${sample.location})` : ""}`);
          for (const line of c.evidence.slice(0, 3)) console.log(`   evidence: ${line}`);
        }
        console.log(`\nlog:\n${result.log.map((l) => `  ${l}`).join("\n")}`);
        break;
      }
      case "add": {
        const user = await cliUser(deps);
        for (const raw of args) {
          const url = ensureHttpUrl(raw);
          const domain = extractDomain(url);
          const [created] = await deps.db
            .insert(schema.companies)
            .values({ name: domain, homepageUrl: url, domain })
            .onConflictDoNothing()
            .returning({ id: schema.companies.id });
          const [company] = created ? [created] : await deps.db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.domain, domain));
          if (!company) throw new Error(`could not add ${domain}`);
          const subscription = await subscribeToCompany(deps.db, user.id, company.id);
          if (created) {
            await enqueueTask(deps.db, "discover", { companyId: created.id, reason: "added" }, {
              dedupeKey: dedupeKeyFor("discover", { companyId: created.id }),
              priority: priorityFor("discover"),
            });
            console.log(`added ${domain} (${created.id}) and followed it as ${user.email}`);
          } else {
            const settings = await deps.userSettings(user.id);
            const outcome = await reevaluateGate(deps.db, user.id, settings, deps.now(), { companyId: company.id });
            console.log(`already tracked: ${domain}; ${subscription.created || subscription.reactivated ? "now" : "already"} followed by ${user.email} (${outcome.created} matching roles added)`);
          }
        }
        break;
      }
      case "discover": {
        const { companies: targets, url } = await discoverTargets(deps.db, args);
        for (const c of targets) {
          await enqueueTask(deps.db, "discover", { companyId: c.id, reason: "manual", url }, {
            dedupeKey: dedupeKeyFor("discover", { companyId: c.id }),
            priority: priorityFor("discover"),
          });
        }
        console.log(targets.length === 1 ? `queued discovery for ${targets[0]!.name}` : `queued discovery for ${targets.length} companies`);
        break;
      }
      case "scan": {
        if (args[0]) {
          const company = await findCompany(deps.db, args[0]);
          await enqueueTask(deps.db, "scan_company", { companyId: company.id, trigger: "manual" }, {
            dedupeKey: dedupeKeyFor("scan_company", { companyId: company.id }),
            priority: priorityFor("scan_company"),
          });
          console.log(`queued a scan of ${company.name}`);
        } else {
          await enqueueTask(deps.db, "run_daily", { trigger: "manual" }, { dedupeKey: null, priority: priorityFor("run_daily") });
          console.log("queued a full run");
        }
        break;
      }
      case "tick": {
        await schedulerTick(deps);
        console.log("scheduler tick complete");
        break;
      }
      case "drain": {
        const n = await queue.drain(Number(args[0] ?? 1000));
        console.log(`processed ${n} task(s)`);
        break;
      }
      case "record": {
        const draftId = args[0];
        if (!draftId || draftId.startsWith("--")) throw new Error("usage: cli record <draft-id> [--out <file>] [--routes <json>]");
        // Paid: refused before anything is read when there is no key to pay with.
        if (!env.anthropicApiKey) throw new Error("record is a live, paid build: set ANTHROPIC_API_KEY first. To rebuild without a key, replay a recording.");
        const out = flag(args, "out");
        const routes = routesFlag(args);
        const { path, report } = await recordCvDraft(deps, draftId, { ...(out ? { path: fromCaller(out) } : {}), ...(routes ? { routes } : {}) });
        console.log(`recorded ${report.calls} call(s) to ${path}`);
        reportReplay(report, undefined);
        break;
      }
      case "replay": {
        const draftId = args[0];
        if (!draftId || draftId.startsWith("--")) throw new Error("usage: cli replay <draft-id> [--recordings <file> | --baseline <file>] [--routes <json>] [--out <report.json>]");
        const recordings = flag(args, "recordings");
        const routes = routesFlag(args);
        let report: CvReplayReport;
        if (recordings) {
          ({ report } = await replayFromRecording(deps, draftId, fromCaller(recordings), routes));
        } else {
          // A live replay calls the provider: paid, and refused without a key.
          if (!env.anthropicApiKey) throw new Error("A replay without --recordings is a live, paid build: set ANTHROPIC_API_KEY, or pass --recordings <file>.");
          // `--baseline <recording>` holds a live run (a candidate route, say) to that recording's grade.
          const baselineFrom = flag(args, "baseline");
          const baseline = baselineFrom ? readRecordingHeader(fromCaller(baselineFrom)).baseline : undefined;
          if (baselineFrom && !baseline) throw new Error(`${baselineFrom} holds no graded baseline; record it again.`);
          ({ report } = await replayCvDraft(deps, draftId, {
            client: createProviderClient(env.anthropicApiKey), ...(routes ? { routes } : {}), source: "live",
            ...(baseline ? { baseline } : {}),
          }));
        }
        reportReplay(report, flag(args, "out"));
        break;
      }
      case "users": {
        const users = await deps.db.select().from(schema.users).orderBy(asc(schema.users.createdAt));
        for (const u of users) console.log(`${u.email.padEnd(40)} ${u.role.padEnd(7)} ${u.claimedAt ? "" : "(unclaimed owner)"} ${u.emailVerifiedAt ? "verified" : "unverified"}`);
        console.log(`\n${users.length} account(s)`);
        break;
      }
      case "list": {
        const companies = await deps.db.select().from(schema.companies).orderBy(schema.companies.name);
        for (const c of companies) {
          const sources = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, c.id));
          const counts = await deps.db.execute<{ open: number; followers: number }>(sql`
            select (select count(*) from jobs where company_id = ${c.id} and status = 'open')::int as open,
                   (select count(*) from company_subscriptions where company_id = ${c.id} and status <> 'archived')::int as followers`);
          const row = counts.rows[0] ?? { open: 0, followers: 0 };
          const sourceText = sources.length
            ? sources.map((s) => `${s.type}${s.atsSlug ? `/${s.atsSlug}` : ""} ${Math.round(s.confidence * 100)}% ${s.status}`).join("; ")
            : "no source";
          console.log(`${c.name.padEnd(28)} ${c.status.padEnd(9)} ${String(row.open).padStart(4)} open ${String(row.followers).padStart(3)} follower(s)  ${sourceText}`);
        }
        break;
      }
      case "table": {
        const user = await cliUser(deps);
        const now = deps.now();
        const rows = await deps.db
          .select({
            company: schema.companies.name,
            website: schema.companies.homepageUrl,
            title: schema.jobs.title,
            url: schema.jobs.url,
            location: schema.jobs.location,
            remote: schema.jobs.remote,
            postedAt: schema.jobs.postedAt,
            firstSeenAt: schema.jobs.firstSeenAt,
            closedAt: schema.jobs.closedAt,
            status: schema.jobs.status,
            fitScore: schema.userJobs.fitScore,
            keywordTerms: schema.userJobs.keywordTerms,
          })
          .from(schema.userJobs)
          .innerJoin(schema.jobs, eq(schema.jobs.id, schema.userJobs.jobId))
          .innerJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
          .where(and(eq(schema.userJobs.userId, user.id), eq(schema.userJobs.inTable, true), sql`${schema.userJobs.archivedAt} is null`))
          .orderBy(desc(schema.jobs.firstSeenAt));
        console.log(["COMPANY", "ROLE", "LOCATION", "LIVE", "STATUS", "FIT", "LINK"].join(" | "));
        for (const r of rows) {
          const live = liveFor({ status: r.status, postedAt: r.postedAt, firstSeenAt: r.firstSeenAt, closedAt: r.closedAt }, now);
          const status = displayStatus({ status: r.status, postedAt: r.postedAt, firstSeenAt: r.firstSeenAt, closedAt: r.closedAt }, now);
          console.log(
            [
              r.company.slice(0, 20),
              r.title.slice(0, 40),
              (r.location ?? (r.remote ? "Remote" : "—")).slice(0, 24),
              `${formatDuration(live.days)}${live.basis === "first_seen" ? "*" : ""}`,
              status,
              r.fitScore ?? "—",
              r.url,
            ].join(" | "),
          );
        }
        console.log(`\n${rows.length} role(s) in ${user.email}'s table. * = counted from first seen, the source publishes no posted date.`);
        break;
      }
    }
  } finally {
    await deps.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
