/**
 * What a client component statically imports is what the browser downloads on first load. zod
 * (about 23 KB gzipped, not tree-shakeable) and the CV schemas used to reach /settings only because
 * the theme picker imported a helper from `@ava/core/cv`, and to /library and /cv/[id] through the
 * editors. This walks the static import graph of every client component the way the bundler does — following value imports and re-exports, stopping at
 * `"use server"` modules (the bundler sends a reference, not the code) and at dynamic `import()`
 * (a separate chunk, loaded only when it runs) — and fails if zod is anywhere in it.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = path.resolve(WEB, "../../packages/core");
const coreExports = JSON.parse(readFileSync(path.join(CORE, "package.json"), "utf8")).exports as Record<string, { default: string }>;

function withExtension(base: string): string | undefined {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** A file path for a local specifier, "zod" for zod itself, or undefined for any other package. */
function resolve(specifier: string, from: string): string | undefined {
  if (specifier === "zod" || specifier.startsWith("zod/")) return "zod";
  if (specifier.startsWith("@/")) return withExtension(path.join(WEB, specifier.slice(2)));
  if (specifier.startsWith(".")) return withExtension(path.resolve(path.dirname(from), specifier));
  if (specifier === "@ava/core" || specifier.startsWith("@ava/core/")) {
    const key = specifier === "@ava/core" ? "." : `./${specifier.slice("@ava/core/".length)}`;
    const target = coreExports[key]?.default;
    if (!target) throw new Error(`${from}: @ava/core has no export ${key}`);
    return path.join(CORE, target);
  }
  return undefined;
}

/** The specifiers of the value imports and re-exports that survive type stripping. */
function valueImports(source: string): string[] {
  const out: string[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+([^;]*?)\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    if (match[4]) { out.push(match[4]); continue; }
    const clause = match[2]!.trim();
    if (/^type\b/.test(clause)) continue;
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    // `import { type A, type B }` is erased entirely by the compiler.
    if (braces && braces[1]!.split(",").map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith("type "))) continue;
    out.push(match[3]!);
  }
  return out;
}

function zodPath(entry: string): string[] | undefined {
  const seen = new Set<string>();
  const walk = (file: string, trail: string[]): string[] | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    if (trail.length > 1 && /^\s*["']use server["']/.test(source)) return undefined;
    for (const specifier of valueImports(source)) {
      const target = resolve(specifier, file);
      if (!target) continue;
      if (target === "zod") return [...trail, "zod"];
      const found = walk(target, [...trail, path.relative(WEB, target)]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(path.join(WEB, entry), [entry]);
}

/** Every `"use client"` module under components/ and app/: each is a client entry the bundler starts from. */
function clientEntries(): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(path.join(WEB, dir))) {
      const relative = path.join(dir, name);
      if (statSync(path.join(WEB, relative)).isDirectory()) { visit(relative); continue; }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      if (/^\s*["']use client["']/.test(readFileSync(path.join(WEB, relative), "utf8"))) out.push(relative);
    }
  };
  visit("components");
  visit("app");
  return out.sort();
}

it("finds the client components it is guarding", () => {
  // /settings' theme picker, and the Library and CV editors, the three that used to ship zod.
  expect(clientEntries()).toEqual(expect.arrayContaining(["components/CvAppearance.tsx", "components/CvLibraryEditor.tsx", "components/CvDraftEditor.tsx"]));
});

// A client component that needs the CV schemas loads them with `await import("@ava/core/cv")` where
// the check runs (see CvDraftEditor's preview and CvLibraryEditor's reload merge), and takes values
// the server already resolved as props; the zod-free parts of the contract are `@ava/core/cv-format`,
// `@ava/core/cv-helpers` and `@ava/core/cv-theme-values`.
it.each(clientEntries())("%s does not bundle zod", (entry) => {
  expect(zodPath(entry)).toBeUndefined();
});

it("sees zod where it is statically imported", () => {
  // The walker itself: the CV contract module is the thing the entries above must not reach.
  expect(zodPath("../../packages/core/src/cv.ts")?.at(-1)).toBe("zod");
  expect(zodPath("../../packages/core/src/cv-theme.ts")).toEqual(["../../packages/core/src/cv-theme.ts", "zod"]);
});

it("keeps the CV page's occasional widgets out of its first load", () => {
  // Each is reached only through `next/dynamic` in CvLazyWidgets; a static import anywhere else
  // would put it back in the page's entry chunk. Tests may import them directly.
  const split = ["CvGapQuiz", "CvShareCreateForm", "CvEvaluationTable"].map((name) => path.join(WEB, "components", `${name}.tsx`));
  const importers: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(path.join(WEB, dir))) {
      const relative = path.join(dir, name);
      if (statSync(path.join(WEB, relative)).isDirectory()) { visit(relative); continue; }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      const file = path.join(WEB, relative);
      for (const specifier of valueImports(readFileSync(file, "utf8"))) {
        if (split.includes(resolve(specifier, file) ?? "")) importers.push(`${relative} -> ${specifier}`);
      }
    }
  };
  visit("app");
  visit("components");
  visit("lib");
  expect(importers).toEqual([]);
  expect(readFileSync(path.join(WEB, "components/CvLazyWidgets.tsx"), "utf8"))
    .toMatch(/import\("\.\/CvGapQuiz"\)[\s\S]*import\("\.\/CvShareCreateForm"\)[\s\S]*import\("\.\/CvEvaluationTable"\)/);
});
