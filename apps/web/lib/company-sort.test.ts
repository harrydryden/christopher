import { expect, it } from "vitest";
import { companySortParams, nextCompanySort, parseCompanySort } from "./company-sort";

it("accepts only whitelisted sort keys and directions", () => {
  expect(parseCompanySort()).toEqual({ sort: "company", dir: "asc" });
  expect(parseCompanySort("open", "asc")).toEqual({ sort: "open", dir: "asc" });
  expect(parseCompanySort("shortlisted")).toEqual({ sort: "shortlisted", dir: "desc" });
  expect(parseCompanySort("status", "sideways")).toEqual({ sort: "status", dir: "desc" });
  // Anything else is the default, never a column name that reaches SQL.
  expect(parseCompanySort("name; drop table companies", "desc")).toEqual({ sort: "company", dir: "desc" });
  expect(parseCompanySort("constructor")).toEqual({ sort: "company", dir: "asc" });
});

it("turns the sorted column round and opens another in its own direction", () => {
  expect(nextCompanySort({ sort: "company", dir: "asc" }, "company")).toEqual({ sort: "company", dir: "desc" });
  expect(nextCompanySort({ sort: "open", dir: "desc" }, "open")).toEqual({ sort: "open", dir: "asc" });
  expect(nextCompanySort({ sort: "company", dir: "asc" }, "review")).toEqual({ sort: "review", dir: "desc" });
  expect(nextCompanySort({ sort: "open", dir: "asc" }, "source")).toEqual({ sort: "source", dir: "asc" });
});

it("leaves the default sort out of the URL", () => {
  expect(companySortParams({ sort: "company", dir: "asc" })).toEqual({});
  expect(companySortParams({ sort: "company", dir: "desc" })).toEqual({ sort: "company", dir: "desc" });
  expect(companySortParams({ sort: "open", dir: "desc" })).toEqual({ sort: "open", dir: "desc" });
});
