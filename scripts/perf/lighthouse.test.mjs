import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mobileConfig, previewConfig, sessionCookie, signedInConfig } from "./lighthouse.mjs";

const committed = JSON.parse(readFileSync(new URL("../../lighthouserc.json", import.meta.url), "utf8"));

test("the committed config errors on LCP, CLS and TBT, and only warns on script transfer, which the bundle budget gates", () => {
  const { collect, assert: rules } = committed.ci;
  assert.equal(collect.numberOfRuns, 3);
  assert.equal(collect.settings.preset, "desktop");
  assert.deepEqual(collect.url.map(url => url.replace("http://127.0.0.1:3124", "")), ["/", "/companies", "/library", "/cv/${DRAFT_ID}"]);
  const [home, rest] = rules.assertMatrix;
  assert.ok(new RegExp(home.matchingUrlPattern).test("http://127.0.0.1:3124/"));
  assert.ok(!new RegExp(home.matchingUrlPattern).test("http://127.0.0.1:3124/companies"));
  assert.ok(new RegExp(rest.matchingUrlPattern).test("http://127.0.0.1:3124/companies"));
  assert.ok(!new RegExp(rest.matchingUrlPattern).test("http://127.0.0.1:3124/"));
  for (const entry of [home, rest]) {
    const a = entry.assertions;
    assert.deepEqual(a["largest-contentful-paint"], ["error", { maxNumericValue: 2500, aggregationMethod: "median-run" }]);
    assert.equal(a["cumulative-layout-shift"][1].maxNumericValue, 0.1);
    assert.deepEqual([a["total-blocking-time"][0], a["total-blocking-time"][1].maxNumericValue], ["error", 200]);
    assert.deepEqual([a.interactive[0], a.interactive[1].maxNumericValue], ["warn", 3800]);
    assert.deepEqual([a["server-response-time"][0], a["server-response-time"][1].maxNumericValue], ["warn", 600]);
  }
  assert.deepEqual(home.assertions["resource-summary:script:size"], ["warn", { maxNumericValue: 134_000, aggregationMethod: "median-run" }]);
  assert.deepEqual(rest.assertions["resource-summary:script:size"], ["warn", { maxNumericValue: 145_000, aggregationMethod: "median-run" }]);
  assert.equal(committed.ci.upload.outputDir, "lighthouse-reports/desktop", "a directory upload-artifact does not skip as hidden");
});

test("the signed-in config fills in the CV and the cookie, and moves the port when asked", () => {
  const config = signedInConfig(committed, { draftId: "d-1", cookie: "col_session=v2.x", port: 3124 });
  assert.equal(config.ci.collect.url[3], "http://127.0.0.1:3124/cv/d-1");
  assert.deepEqual(JSON.parse(config.ci.collect.settings.extraHeaders), { cookie: "col_session=v2.x" });
  assert.equal(committed.ci.collect.settings.extraHeaders, undefined, "the committed file is not changed");
  const moved = signedInConfig(committed, { draftId: "d-1", cookie: "c", port: 4000 });
  assert.ok(moved.ci.collect.url.every(url => url.startsWith("http://127.0.0.1:4000/")));
  assert.ok(new RegExp(moved.ci.assert.assertMatrix[0].matchingUrlPattern).test("http://127.0.0.1:4000/"));
});

test("the mobile pass drops the desktop preset and only warns", () => {
  const mobile = mobileConfig(signedInConfig(committed, { draftId: "d", cookie: "c" }));
  assert.equal(mobile.ci.collect.settings.preset, undefined);
  assert.ok(mobile.ci.collect.settings.extraHeaders, "still signed in");
  for (const entry of mobile.ci.assert.assertMatrix) for (const rule of Object.values(entry.assertions)) assert.equal(rule[0], "warn");
  assert.equal(mobile.ci.upload.outputDir, "lighthouse-reports/mobile");
});

test("the cookie is the interface's own shape", () => {
  const cookie = sessionCookie("secret", "session-1", 1_800_000_000);
  const sig = createHmac("sha256", "secret").update("session-1.1800000000").digest("base64url");
  assert.equal(cookie, `col_session=v2.session-1.1800000000.${sig}`);
});

test("the preview pass is /login signed out, with the bypass header, warnings only, and no cookie", () => {
  const config = previewConfig(committed, { url: "https://col-git-branch.vercel.app/some/path", bypass: "bypass-secret" });
  assert.deepEqual(config.ci.collect.url, ["https://col-git-branch.vercel.app/login"]);
  assert.equal(config.ci.collect.settings.preset, "desktop");
  assert.deepEqual(JSON.parse(config.ci.collect.settings.extraHeaders), { "x-vercel-protection-bypass": "bypass-secret", "x-vercel-set-bypass-cookie": "true" });
  for (const rule of Object.values(config.ci.assert.assertions)) assert.equal(rule[0], "warn");
  assert.equal(previewConfig(committed, { url: "https://x.vercel.app" }).ci.collect.settings.extraHeaders, undefined);
});
