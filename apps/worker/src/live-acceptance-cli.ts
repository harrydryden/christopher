import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LIVE_ACCEPTANCE_CASES } from "./live-acceptance-manifest";
import { runLiveAcceptanceCase, summariseLiveAcceptance, liveAcceptanceVerdict, type LiveAcceptanceResult } from "./live-acceptance";
import { PoliteFetcher, userAgentFor } from "./fetcher";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const limitRaw = valueAfter(args, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : LIVE_ACCEPTANCE_CASES.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIVE_ACCEPTANCE_CASES.length) throw new Error(`--limit must be 1-${LIVE_ACCEPTANCE_CASES.length}`);
  const ids = valueAfter(args, "--ids")?.split(",").map(v => v.trim()).filter(Boolean);
  const discoveryOnly = args.includes("--discovery-only");
  const selected = (ids ? LIVE_ACCEPTANCE_CASES.filter(item => ids.includes(item.id)) : LIVE_ACCEPTANCE_CASES).slice(0, limit);
  if (!selected.length) throw new Error("no manifest cases selected");
  const unknown = ids?.filter(id => !LIVE_ACCEPTANCE_CASES.some(item => item.id === id)) ?? [];
  if (unknown.length) throw new Error(`unknown case id(s): ${unknown.join(", ")}`);

  const results: LiveAcceptanceResult[] = [];
  const fetcher = new PoliteFetcher({
    userAgent: userAgentFor(process.env.CONTACT_EMAIL ?? "christopher-live-acceptance@example.invalid"),
    respectRobots: () => true,
  });
  let next = 0;
  const workers = Array.from({ length: Math.min(3, selected.length) }, async () => {
    while (next < selected.length) {
      const index = next++;
      const item = selected[index]!;
      process.stderr.write(`[${index + 1}/${selected.length}] ${item.company}\n`);
      const result = await runLiveAcceptanceCase(item, { discoveryOnly, fetcher });
      results[index] = result;
    }
  });
  await Promise.all(workers);
  const metrics = summariseLiveAcceptance(selected, results);
  const acceptance = liveAcceptanceVerdict(selected, metrics);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: discoveryOnly ? "discovery_only" : "discovery_and_extraction",
    limitations: [
      "This is a live observation, so role counts and pages can change during the run.",
      "A null metric means the required independent label does not exist; it is not a pass.",
      "No browser or AI fallback is used, and no database is read or written.",
    ],
    acceptance,
    metrics,
    cases: selected.map(item => ({ manifest: item, result: results.find(result => result.id === item.id) })),
  };
  const defaultName = `docs/live-acceptance-${report.generatedAt.replace(/[:.]/g, "-")}.json`;
  const output = resolve(valueAfter(args, "--output") ?? defaultName);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${output}\n${JSON.stringify(report.metrics, null, 2)}\n`);
  if (acceptance.verdict === "fail") process.exitCode = 1;
  else if (acceptance.verdict === "blocked") process.exitCode = 2;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
