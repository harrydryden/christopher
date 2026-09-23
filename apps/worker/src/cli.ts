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
 *
 * Per-account commands act for AVA_CLI_USER (an email) or, when unset, the earliest
 * administrator.
 *
 * Every command except `migrate` first checks that the database is at exactly this checkout's
 * schema and refuses otherwise, so looking at production from a branch never migrates it.
 */
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
} from "@ava/core";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { createDeps, makeDiscoveryContext, type WorkerDeps } from "./context";
import { readEnv } from "./env";
import { assertSchemaCurrent, discoverTargets, findCompany, schemaState } from "./cli-guards";
import { handlers } from "./handlers";
import { TaskQueue } from "./queue";
import { schedulerTick } from "./scheduler";

async function cliUser(deps: WorkerDeps) {
  const email = renamedEnv(process.env, "AVA_CLI_USER", "CHRISTOPHER_CLI_USER")?.trim().toLowerCase();
  const rows = email
    ? await deps.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1)
    : await deps.db.select().from(schema.users).where(and(eq(schema.users.role, "admin"), sql`${schema.users.claimedAt} is not null`)).orderBy(asc(schema.users.createdAt)).limit(1);
  const user = rows[0];
  if (!user) throw new Error(email ? `no account with email ${email}` : "no administrator account yet; sign up in the interface first");
  return user;
}

const COMMANDS = new Set(["migrate", "probe", "add", "discover", "scan", "tick", "drain", "users", "list", "table"]);

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !COMMANDS.has(command)) {
    console.log("commands: migrate | probe <url> | add <url...> | discover <company> [url] | discover --all | scan [company] | tick | drain [n] | list | table | users");
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
