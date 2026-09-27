/**
 * First-load JavaScript per route, gzipped, against the budgets in scripts/bundle-budget.json.
 *
 *   node scripts/bundle-budget.mjs [apps/web/.next] [--budget scripts/bundle-budget.json]
 *
 * Reads what `next build` leaves behind: `app-build-manifest.json` `.pages` (the files each layout
 * and page segment loads) and `build-manifest.json` `.rootMainFiles` (the runtime every App Router
 * page loads). A route's first load is the union of the root files, `/layout`, `/(app)/layout`
 * (and `/(app)/admin/layout` under admin) and the page's own files, `.js` only, each chunk counted
 * once, gzipped at level 9 as the audits measured it (docs/performance/A-after.md §4).
 *
 * It fails when a route is over its budget (`routes`, `"*"` for a route not listed), when the shared
 * root is over `sharedRoot`, or when a route's first load holds more chunks of `largeChunkBytes`
 * or more than `largeChunks` records for it: a new large chunk entering a first load, which is how
 * the 23.8 KB zod chunk arrived. Chunks are compared by route and by count, never by file name,
 * because a build renames them. A deliberate increase raises the figure in the JSON in the same pull
 * request, so the diff records the decision.
 *
 * The table goes to stdout and, in GitHub Actions, to the step summary.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/** `/(app)/companies/[id]/page` → `/companies/[id]`; route groups are not part of the URL. */
export function routeOf(page) {
  const path = page.replace(/\/page$/, "").split("/").filter(segment => segment && !/^\(.+\)$/.test(segment)).join("/");
  return `/${path}`;
}

/** The layout segments above a page, outermost first, as the App Router loads them. */
export function layoutChain(page) {
  const chain = ["/layout"];
  const segments = page.replace(/\/page$/, "").split("/").filter(Boolean);
  let prefix = "";
  for (const segment of segments) {
    prefix += `/${segment}`;
    chain.push(`${prefix}/layout`);
  }
  return chain;
}

/**
 * Every page's first-load chunk list: root files, then each layout's files, then the page's, `.js`
 * only, each file once.
 */
export function firstLoads(appManifest, rootMainFiles) {
  const pages = appManifest.pages ?? {};
  return Object.keys(pages).filter(page => page.endsWith("/page")).sort().map(page => {
    const files = [...rootMainFiles];
    for (const layout of layoutChain(page)) files.push(...(pages[layout] ?? []));
    files.push(...pages[page]);
    return { page, route: routeOf(page), files: [...new Set(files)].filter(file => file.endsWith(".js")) };
  });
}

/** Sizes read once per chunk however many routes load it. */
export function chunkSizer(nextDir, read = path => readFileSync(path)) {
  const cache = new Map();
  return file => {
    let size = cache.get(file);
    if (!size) {
      const bytes = read(join(nextDir, file));
      size = { raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
      cache.set(file, size);
    }
    return size;
  };
}

export function measure(nextDir, read) {
  const appManifest = JSON.parse(String((read ?? readFileSync)(join(nextDir, "app-build-manifest.json"))));
  const buildManifest = JSON.parse(String((read ?? readFileSync)(join(nextDir, "build-manifest.json"))));
  const rootMainFiles = (buildManifest.rootMainFiles ?? []).filter(file => file.endsWith(".js"));
  const size = chunkSizer(nextDir, read);
  const sum = files => files.reduce((total, file) => { const s = size(file); return { raw: total.raw + s.raw, gzip: total.gzip + s.gzip }; }, { raw: 0, gzip: 0 });
  const routes = firstLoads(appManifest, rootMainFiles).map(entry => ({
    ...entry,
    ...sum(entry.files),
    chunks: entry.files.map(file => ({ file, ...size(file) })),
  }));
  return { sharedRoot: { files: rootMainFiles, ...sum(rootMainFiles) }, routes };
}

const budgetFor = (table, route) => table?.[route] ?? table?.["*"];

/**
 * The measurement against the budget: one row per route and the failures, if any. A route served
 * by more than one page (a group and its twin) is held to the same figure; each page is a row.
 */
export function check(measurement, budget) {
  const largeBytes = budget.largeChunkBytes ?? 20_480;
  const failures = [];
  const rows = measurement.routes.map(route => {
    const limit = budgetFor(budget.routes, route.route);
    const large = route.chunks.filter(chunk => chunk.gzip >= largeBytes);
    const allowedLarge = budgetFor(budget.largeChunks, route.route);
    const row = { route: route.route, page: route.page, chunks: route.files.length, raw: route.raw, gzip: route.gzip, budget: limit ?? null, largeChunks: large.length, allowedLarge: allowedLarge ?? null, ok: true };
    if (typeof limit !== "number") {
      row.ok = false;
      failures.push(`${route.route}: no budget, and no "*" budget to fall back to`);
    } else if (route.gzip > limit) {
      row.ok = false;
      failures.push(`${route.route}: first-load JS is ${route.gzip.toLocaleString("en-GB")} B gzip, over its budget of ${limit.toLocaleString("en-GB")} B`);
    }
    if (typeof allowedLarge === "number" && large.length > allowedLarge) {
      row.ok = false;
      const listed = large.map(chunk => `${chunk.file} (${chunk.gzip.toLocaleString("en-GB")} B)`).join(", ");
      failures.push(`${route.route}: ${large.length} chunks of ${largeBytes.toLocaleString("en-GB")} B gzip or more in its first load, where ${allowedLarge} are recorded: ${listed}`);
    }
    return row;
  });
  const shared = { route: "shared root", chunks: measurement.sharedRoot.files.length, raw: measurement.sharedRoot.raw, gzip: measurement.sharedRoot.gzip, budget: budget.sharedRoot ?? null, ok: true };
  if (typeof budget.sharedRoot === "number" && shared.gzip > budget.sharedRoot) {
    shared.ok = false;
    failures.push(`shared root: ${shared.gzip.toLocaleString("en-GB")} B gzip, over its budget of ${budget.sharedRoot.toLocaleString("en-GB")} B`);
  }
  rows.sort((a, b) => b.gzip - a.gzip || a.route.localeCompare(b.route));
  return { rows: [...rows, shared], failures };
}

const n = value => (value === null || value === undefined ? "–" : value.toLocaleString("en-GB"));

export function markdownTable(rows) {
  const lines = [
    "| route | chunks | first-load raw | gzip | budget | headroom | chunks ≥ 20 KB | |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of rows) {
    const headroom = typeof row.budget === "number" ? `${(((row.budget - row.gzip) / row.budget) * 100).toFixed(1)} %` : "–";
    const large = row.largeChunks === undefined ? "–" : `${row.largeChunks}${row.allowedLarge === null ? "" : ` of ${row.allowedLarge}`}`;
    lines.push(`| \`${row.route}\` | ${row.chunks} | ${n(row.raw)} | ${n(row.gzip)} | ${n(row.budget)} | ${headroom} | ${large} | ${row.ok ? "ok" : "**over**"} |`);
  }
  return lines.join("\n");
}

function main(argv, env) {
  const args = argv.slice(2);
  const budgetAt = args.indexOf("--budget");
  const budgetPath = budgetAt >= 0 ? args[budgetAt + 1] : new URL("./bundle-budget.json", import.meta.url);
  const nextDir = resolve(args.find((arg, index) => !arg.startsWith("--") && index !== budgetAt + 1) ?? "apps/web/.next");
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const { rows, failures } = check(measure(nextDir), budget);
  const table = markdownTable(rows);
  const report = `### First-load JavaScript per route (gzip level 9)\n\n${table}\n\n${failures.length ? `**Over budget:**\n\n- ${failures.join("\n- ")}\n\nRaise the figure in \`scripts/bundle-budget.json\` in this pull request if the growth is intended.` : "Every route is within its budget."}\n`;
  console.log(report);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, report);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv, process.env);
