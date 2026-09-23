/**
 * Static checks on what the deployment is built from: the manifests, the worker image and the
 * Render blueprint. Each guards a way the build could change without a reviewable diff.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
const manifests = ["package.json", ...["apps", "packages"].flatMap(dir =>
  readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => `${dir}/${entry.name}/package.json`))];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

test("no manifest takes whatever version happens to be newest", () => {
  const floating = [];
  for (const path of manifests) {
    const manifest = JSON.parse(read(path));
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        if (["latest", "*", ""].includes(specifier.trim()) || specifier.startsWith("latest")) floating.push(`${path} ${name}@${specifier}`);
      }
    }
  }
  assert.deepEqual(floating, [], "pin these to the version pnpm-lock.yaml resolves");
});

test("a dependency declared by several workspaces is declared the same way in each", () => {
  const seen = new Map();
  for (const path of manifests) {
    const manifest = JSON.parse(read(path));
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        if (specifier.startsWith("workspace:")) continue;
        seen.set(name, [...(seen.get(name) ?? []), `${path}: ${specifier}`]);
      }
    }
  }
  const drifting = [...seen].filter(([, uses]) => new Set(uses.map(use => use.split(": ")[1])).size > 1);
  assert.deepEqual(drifting, []);
});
