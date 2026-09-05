/**
 * Operational CLI. Run one-off jobs without waiting for the scheduler:
 *   pnpm --filter @christopher/worker cli add <homepage-url>
 *   pnpm --filter @christopher/worker cli discover <company-id|domain>
 *   pnpm --filter @christopher/worker cli scan [company-id|domain]
 *   pnpm --filter @christopher/worker cli drain          (run queued tasks to completion)
 *   pnpm --filter @christopher/worker cli list           (companies, sources, counts)
 *   pnpm --filter @christopher/worker cli table          (the roles table as text)
 */
import { schema, enqueueTask, runMigrations } from "@christopher/db";
import {
  dedupeKeyFor,
  displayStatus,
  ensureHttpUrl,
  extractDomain,
  formatDuration,
  liveFor,
  priorityFor,
} from "@christopher/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createDeps } from "./context";
import { readEnv } from "./env";
import { handlers } from "./handlers";
import { ensureSeedTags } from "./handlers/learning";
import { TaskQueue } from "./queue";
import { schedulerTick } from "./scheduler";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const env = readEnv();
  const deps = await createDeps(env);
  await runMigrations(deps.db);
  await ensureSeedTags(deps);
  const queue = new TaskQueue(deps, handlers, { concurrency: 1, workerId: "cli" });

  const findCompany = async (needle: string) => {
    const rows = await deps.db.select().from(schema.companies);
    return rows.find((c) => c.id === needle || c.domain === needle || c.name.toLowerCase() === needle.toLowerCase()) ?? null;
  };

  try {
    switch (command) {
      case "add": {
        for (const raw of args) {
          const url = ensureHttpUrl(raw);
          const domain = extractDomain(url);
          const [created] = await deps.db
            .insert(schema.companies)
            .values({ name: domain, homepageUrl: url, domain })
            .onConflictDoNothing()
            .returning({ id: schema.companies.id });
          if (!created) {
            console.log(`already tracked: ${domain}`);
            continue;
          }
          await enqueueTask(deps.db, "discover", { companyId: created.id, reason: "added" }, {
            dedupeKey: dedupeKeyFor("discover", { companyId: created.id }),
            priority: priorityFor("discover"),
          });
          console.log(`added ${domain} (${created.id})`);
        }
        break;
      }
      case "discover": {
        const company = args[0] ? await findCompany(args[0]) : null;
        const targets = company ? [company] : await deps.db.select().from(schema.companies).where(eq(schema.companies.status, "active"));
        for (const c of targets) {
          await enqueueTask(deps.db, "discover", { companyId: c.id, reason: "manual", url: args[1] }, {
            dedupeKey: dedupeKeyFor("discover", { companyId: c.id }),
            priority: priorityFor("discover"),
          });
        }
        console.log(`queued discovery for ${targets.length} company(ies)`);
        break;
      }
      case "scan": {
        if (args[0]) {
          const company = await findCompany(args[0]);
          if (!company) throw new Error(`no company matching ${args[0]}`);
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
      case "list": {
        const companies = await deps.db.select().from(schema.companies).orderBy(schema.companies.name);
        for (const c of companies) {
          const sources = await deps.db.select().from(schema.careerSources).where(eq(schema.careerSources.companyId, c.id));
          const counts = await deps.db.execute<{ open: number; table: number }>(sql`
            select count(*) filter (where status = 'open')::int as open,
                   count(*) filter (where status = 'open' and in_table)::int as "table"
            from jobs where company_id = ${c.id}`);
          const row = counts.rows[0] ?? { open: 0, table: 0 };
          const sourceText = sources.length
            ? sources.map((s) => `${s.type}${s.atsSlug ? `/${s.atsSlug}` : ""} ${Math.round(s.confidence * 100)}% ${s.status}`).join("; ")
            : "no source";
          console.log(`${c.name.padEnd(28)} ${c.status.padEnd(9)} ${String(row.open).padStart(4)} open ${String(row.table).padStart(4)} in table  ${sourceText}`);
        }
        break;
      }
      case "table": {
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
            fitScore: schema.jobs.fitScore,
            keywordTerms: schema.jobs.keywordTerms,
          })
          .from(schema.jobs)
          .innerJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
          .where(eq(schema.jobs.inTable, true))
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
        console.log(`\n${rows.length} role(s) in the table. * = counted from first seen, the source publishes no posted date.`);
        break;
      }
      default:
        console.log("commands: add <url...> | discover [company] [url] | scan [company] | tick | drain [n] | list | table");
    }
  } finally {
    await deps.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
