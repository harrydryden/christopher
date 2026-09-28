import { expect, it } from "vitest";
import { ifMigrated, missingRelation, presentOnceFound } from "./schema-skew";

const failing = (code: string, wrapped = false) => {
  const error = Object.assign(new Error(`failed with ${code}`), { code });
  return wrapped ? Object.assign(new Error("query failed"), { cause: error }) : error;
};

it("degrades only on a missing table or column, however the driver wrapped it", async () => {
  expect(missingRelation(failing("42P01"))).toBe(true);
  expect(missingRelation(failing("42703", true))).toBe(true);
  expect(missingRelation(failing("57014"))).toBe(false);
  expect(missingRelation(new Error("no code"))).toBe(false);

  expect(await ifMigrated(async () => { throw failing("42P01", true); }, () => "fallback")).toBe("fallback");
  // A statement timeout is the read failing, not a schema behind it.
  await expect(ifMigrated(async () => { throw failing("57014"); }, () => "fallback")).rejects.toThrow("failed with 57014");
  expect(await ifMigrated(async () => "read", () => "fallback")).toBe("read");
});

it("remembers a probe once it finds the schema, and asks again until then", async () => {
  const answers = [false, true, false];
  let asked = 0;
  const present = presentOnceFound(async () => answers[asked++]!);
  expect(await present()).toBe(false);
  expect(await present()).toBe(true);
  expect(await present()).toBe(true);
  expect(asked).toBe(2);

  let calls = 0;
  const flaky = presentOnceFound(async () => { calls += 1; if (calls === 1) throw new Error("timeout"); return true; });
  await expect(flaky()).rejects.toThrow("timeout");
  expect(await flaky()).toBe(true);
});
