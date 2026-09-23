/**
 * Every export of a `"use server"` module is a public endpoint: Next registers it as an action a
 * browser can call with whatever arguments it likes. So none may take a database handle or a
 * transaction from its caller: such a helper trusts the account it is handed, and belongs in
 * `lib/`, where nothing can call it from outside. `writeCvLibraryVersion` was one, until it moved.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

/** Each exported function in a module: its name and its parameter list. */
function exportedFunctions(source: string): Array<{ name: string; params: string }> {
  const found: Array<{ name: string; params: string }> = [];
  const header = /export\s+async\s+function\s+(\w+)\s*\(/g;
  for (let match = header.exec(source); match; match = header.exec(source)) {
    let depth = 1;
    let at = header.lastIndex;
    while (depth && at < source.length) {
      if (source[at] === "(") depth++;
      else if (source[at] === ")") depth--;
      at++;
    }
    found.push({ name: match[1]!, params: source.slice(header.lastIndex, at - 1) });
  }
  return found;
}

it("exports nothing from a server-action module that takes a database handle from its caller", async () => {
  const files = [...await sourceFiles(join(ROOT, "app")), ...await sourceFiles(join(ROOT, "lib"))];
  const problems: string[] = [];
  let checked = 0;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!/^\s*["']use server["']/.test(source)) continue;
    for (const fn of exportedFunctions(source)) {
      checked++;
      if (/^\s*(tx|db|database)\b/.test(fn.params)) problems.push(`${relative(ROOT, file)}: ${fn.name}`);
    }
  }
  expect(checked).toBeGreaterThan(20);
  expect(problems).toEqual([]);
});
