import { expect, it } from "vitest";
import { isCvPage } from "./cv-table-data";
it("accepts server and JSON table snapshots and rejects corrupt data before rendering", () => {
  const row = {
    id: "test",
    company: "Example",
    jobTitle: "Director",
    status: "ready",
    revision: 1,
    createdAt: new Date(),
  };
  const page = { rows: [row], total: 1, page: 1 };
  expect(isCvPage(page)).toBe(true);
  expect(isCvPage(JSON.parse(JSON.stringify(page)))).toBe(true);
  expect(isCvPage({ rows: [], total: 0, page: 1 })).toBe(true);
  for (const value of [
    null,
    {},
    { ...page, rows: null },
    { ...page, page: 0 },
    { ...page, total: -1 },
    { ...page, rows: [{ ...row, createdAt: "invalid" }] },
    { ...page, rows: [{ ...row, company: 42 }] },
    { ...page, rows: Array(51).fill(row) },
  ])
    expect(isCvPage(value)).toBe(false);
});
