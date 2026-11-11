import { expect, it } from "vitest";
import { CareerDatesSchema, careerPrivateRecordIds } from "./career-record";

it.each([
  { start: "2024", end: "2023", current: false },
  { start: "2024-11", end: "2024-03", current: false },
  { start: "2023", end: "2024", current: true },
])("rejects an impossible date range within one career record: $start–$end", dates => {
  expect(CareerDatesSchema.safeParse(dates).success).toBe(false);
});

it("preserves unknown and partially known dates without inventing chronology", () => {
  for (const dates of [
    { start: null, end: null, current: false },
    { start: null, end: null, current: true },
    { start: "2024-11", end: "2024", current: false },
    { start: "2024", end: "2024-01", current: false },
  ]) expect(CareerDatesSchema.parse(dates)).toEqual(dates);
});

it("carries a private client context to nested work without hiding unrelated work at the public employer", () => {
  const records = ["client", "project", "contribution", "employer", "other-role"]
    .map(id => ({ id, confidential: false }));
  const links = [
    { fromId: "project", toId: "client", kind: "delivered_for", confidential: true, archived: false },
    { fromId: "contribution", toId: "project", kind: "part_of", confidential: false, archived: false },
    { fromId: "project", toId: "employer", kind: "employed_by", confidential: false, archived: false },
    { fromId: "other-role", toId: "employer", kind: "employed_by", confidential: false, archived: false },
  ];
  expect(careerPrivateRecordIds(records, links)).toEqual(new Set(["project", "contribution"]));
  expect(careerPrivateRecordIds(records.map(row => ({ ...row, confidential: row.id === "client" })),
    links.map(row => ({ ...row, confidential: false })))).toEqual(new Set(["client", "project", "contribution"]));
});
