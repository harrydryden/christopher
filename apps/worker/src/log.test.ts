/** LOG_LEVEL decides which lines are written, however the operator spelled it. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseLogLevel } from "./log";

it.each([
  ["debug", "debug"], ["DEBUG", "debug"], [" Warn ", "warn"], ["warning", "warn"], ["ERROR", "error"],
  ["", "info"], [undefined, "info"], ["verbose", "info"], ["constructor", "info"],
] as const)("reads LOG_LEVEL=%j as %s", (value, level) => {
  expect(parseLogLevel(value)).toBe(level);
});

it("writes only lines at or above the configured level", () => {
  const script = "import { log } from './src/log.ts'; log.debug('d'); log.info('i'); log.warn('w'); log.error('e');";
  const run = (level: string) => {
    const out = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, LOG_LEVEL: level },
      encoding: "utf8",
    });
    return `${out.stdout}${out.stderr}`.trim().split("\n").filter(Boolean).map(line => (JSON.parse(line) as { msg: string }).msg).sort();
  };
  expect(run("WARN")).toEqual(["e", "w"]);
  expect(run("debug")).toEqual(["d", "e", "i", "w"]);
  expect(run("info")).toEqual(["e", "i", "w"]);
});
