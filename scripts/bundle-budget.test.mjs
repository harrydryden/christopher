import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { check, firstLoads, layoutChain, markdownTable, measure, routeOf } from "./bundle-budget.mjs";

/** Incompressible bytes, so a chunk's gzip size is close to its raw size and budgets are easy to aim. */
const noise = bytes => randomBytes(bytes);

/**
 * A synthetic `.next`: two App Router pages under the `(app)` group, an admin page with its own
 * layout, a route handler that must be ignored, and a CSS file that must not count.
 */
function fixture(extraPageChunk) {
  const dir = mkdtempSync(join(tmpdir(), "col-bundle-budget-"));
  const files = {
    "static/chunks/webpack-aaa.js": noise(2_000),
    "static/chunks/main-app-bbb.js": noise(3_000),
    "static/chunks/app/layout-ccc.js": noise(1_000),
    "static/chunks/app/(app)/layout-ddd.js": noise(1_500),
    "static/chunks/shared-eee.js": noise(4_000),
    "static/chunks/app/(app)/page-fff.js": noise(500),
    "static/chunks/app/(app)/companies/[id]/page-ggg.js": noise(700),
    "static/chunks/app/(app)/admin/layout-hhh.js": noise(600),
    "static/chunks/app/(app)/admin/page-iii.js": noise(300),
    "static/css/app-jjj.css": noise(9_000),
    ...(extraPageChunk ? { "static/chunks/big-kkk.js": noise(extraPageChunk) } : {}),
  };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  const pages = {
    "/layout": ["static/chunks/webpack-aaa.js", "static/css/app-jjj.css", "static/chunks/app/layout-ccc.js"],
    "/(app)/layout": ["static/chunks/webpack-aaa.js", "static/chunks/app/(app)/layout-ddd.js", "static/chunks/shared-eee.js"],
    "/(app)/page": ["static/chunks/webpack-aaa.js", "static/chunks/shared-eee.js", "static/chunks/app/(app)/page-fff.js", ...(extraPageChunk ? ["static/chunks/big-kkk.js"] : [])],
    "/(app)/companies/[id]/page": ["static/chunks/shared-eee.js", "static/chunks/app/(app)/companies/[id]/page-ggg.js"],
    "/(app)/admin/layout": ["static/chunks/app/(app)/admin/layout-hhh.js"],
    "/(app)/admin/page": ["static/chunks/app/(app)/admin/page-iii.js"],
    "/api/health/route": ["static/chunks/webpack-aaa.js"],
  };
  writeFileSync(join(dir, "app-build-manifest.json"), JSON.stringify({ pages }));
  writeFileSync(join(dir, "build-manifest.json"), JSON.stringify({ rootMainFiles: ["static/chunks/webpack-aaa.js", "static/chunks/main-app-bbb.js"], polyfillFiles: [], pages: {} }));
  const gz = path => gzipSync(readFileSync(join(dir, path)), { level: 9 }).length;
  return { dir, gz, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("routes drop their groups and the page segment", () => {
  assert.equal(routeOf("/(app)/page"), "/");
  assert.equal(routeOf("/(app)/companies/[id]/page"), "/companies/[id]");
  assert.equal(routeOf("/(auth)/login/page"), "/login");
  assert.equal(routeOf("/(app)/admin/health/page"), "/admin/health");
  assert.deepEqual(layoutChain("/(app)/admin/page"), ["/layout", "/(app)/layout", "/(app)/admin/layout"]);
});

test("a first load is the union of the root files, every layout above the page and the page, each chunk once", () => {
  const loads = firstLoads({ pages: {
    "/layout": ["root.js", "a.css", "layout.js"],
    "/(app)/layout": ["root.js", "app-layout.js", "shared.js"],
    "/(app)/admin/layout": ["admin-layout.js"],
    "/(app)/admin/page": ["shared.js", "admin.js"],
    "/api/x/route": ["route.js"],
  } }, ["root.js", "main.js"]);
  assert.equal(loads.length, 1, "route handlers are not pages");
  assert.deepEqual(loads[0], { page: "/(app)/admin/page", route: "/admin", files: ["root.js", "main.js", "layout.js", "app-layout.js", "shared.js", "admin-layout.js", "admin.js"] });
});

test("sizes are gzip level 9, shared chunks count once per route, and CSS does not count", () => {
  const f = fixture();
  try {
    const m = measure(f.dir);
    const home = m.routes.find(r => r.route === "/");
    const expected = ["static/chunks/webpack-aaa.js", "static/chunks/main-app-bbb.js", "static/chunks/app/layout-ccc.js", "static/chunks/app/(app)/layout-ddd.js", "static/chunks/shared-eee.js", "static/chunks/app/(app)/page-fff.js"];
    assert.deepEqual(home.files, expected);
    assert.equal(home.gzip, expected.reduce((t, p) => t + f.gz(p), 0));
    assert.equal(m.sharedRoot.gzip, f.gz("static/chunks/webpack-aaa.js") + f.gz("static/chunks/main-app-bbb.js"));
    const admin = m.routes.find(r => r.route === "/admin");
    assert.ok(admin.files.includes("static/chunks/app/(app)/admin/layout-hhh.js"), "the admin layout is in the admin first load");
    assert.ok(!home.files.includes("static/chunks/app/(app)/admin/layout-hhh.js"), "and only there");
  } finally { f.cleanup(); }
});

test("every route passes under its budget, and an unlisted route falls back to \"*\"", () => {
  const f = fixture();
  try {
    const m = measure(f.dir);
    const { rows, failures } = check(m, { sharedRoot: 100_000, routes: { "/": 100_000, "*": 100_000 }, largeChunkBytes: 20_480, largeChunks: { "*": 0 } });
    assert.deepEqual(failures, []);
    assert.equal(rows.find(r => r.route === "/companies/[id]").budget, 100_000, "the fallback applies");
    assert.equal(rows.at(-1).route, "shared root");
    assert.match(markdownTable(rows), /\| `\/` \| 6 \|/);
  } finally { f.cleanup(); }
});

test("a route over its budget fails, and so does the shared root", () => {
  const f = fixture();
  try {
    const m = measure(f.dir);
    const home = m.routes.find(r => r.route === "/").gzip;
    const tight = check(m, { sharedRoot: 1_000, routes: { "/": home - 1, "*": 100_000 } });
    assert.equal(tight.failures.length, 2);
    assert.match(tight.failures[0], /^\/: first-load JS is .* over its budget/);
    assert.match(tight.failures[1], /^shared root:/);
    assert.equal(check(m, { routes: { "/": home, "*": 100_000 } }).failures.length, 0, "the budget is inclusive");
    assert.match(check(m, { routes: { "/": 100_000 } }).failures[0], /no budget/);
  } finally { f.cleanup(); }
});

test("a chunk of 20 KB gzip or more newly entering a first load fails even inside the byte budget", () => {
  const f = fixture(24_000);
  try {
    const m = measure(f.dir);
    const budget = { sharedRoot: 100_000, routes: { "*": 500_000 }, largeChunkBytes: 20_480, largeChunks: { "*": 0 } };
    const { failures, rows } = check(m, budget);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^\/: 1 chunks of 20,480 B gzip or more .* where 0 are recorded: static\/chunks\/big-kkk\.js/);
    assert.equal(rows.find(r => r.route === "/").ok, false);
    assert.deepEqual(check(m, { ...budget, largeChunks: { "/": 1, "*": 0 } }).failures, [], "recording it is the decision that lets it through");
  } finally { f.cleanup(); }
});
