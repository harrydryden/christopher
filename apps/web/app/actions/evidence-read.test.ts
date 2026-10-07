import { expect, it, vi } from "vitest";
import { openEvidenceDrafts } from "./evidence";

let failure: unknown;
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "person-1" }), requireVerifiedUser: async () => ({ id: "person-1" }) }));
vi.mock("@/lib/db", () => ({ db: () => ({ select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({
  limit: async () => { throw failure; },
}) }) }) }) }) }));

it("opens Experience before the additive draft table has been migrated", async () => {
  failure = Object.assign(new Error("relation does not exist"), { code: "42P01" });
  expect(await openEvidenceDrafts("library")).toEqual([]);
  failure = Object.assign(new Error("wrapped"), { cause: { code: "42P01" } });
  expect(await openEvidenceDrafts("library")).toEqual([]);
});

it("does not hide an unrelated database failure", async () => {
  failure = Object.assign(new Error("database unavailable"), { code: "08006" });
  await expect(openEvidenceDrafts("library")).rejects.toThrow("database unavailable");
});
