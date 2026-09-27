/**
 * The functions that can run long say how long they may. Without `maxDuration`, Fluid compute lets
 * a function run 300 s, so one pathological CV would cost ten times the 30 s its render could ever
 * legitimately need (a render takes about a second, bounded by `cv-render-limit.ts`). Server
 * actions take their page's limit, which is why the CV page is here: its `recordApplication`
 * renders a PDF. Read from the source, because Next reads it from there too, as a literal.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const LIMITS: Record<string, number> = {
  "api/cv/[id]/pdf/route.ts": 30,
  "api/cv/preview/route.ts": 30,
  "api/applications/[id]/pdf/route.ts": 30,
  "(app)/cv/[id]/page.tsx": 30,
  "api/cv/library/imports/route.ts": 60,
  "api/cron/route.ts": 60,
  "api/export.csv/route.ts": 60,
};

it.each(Object.entries(LIMITS))("%s declares maxDuration %i", async (file, seconds) => {
  const source = await readFile(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
  const declared = [...source.matchAll(/^export const maxDuration = (\d+);$/gm)].map(match => Number(match[1]));
  expect(declared).toEqual([seconds]);
});
