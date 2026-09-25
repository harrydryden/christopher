import { expect, it } from "vitest";
import { domainFromQuery } from "./catalogue-query";

it("reads a homepage, with or without a scheme or a path, as its registrable domain", () => {
  expect(domainFromQuery("acme.com")).toBe("acme.com");
  expect(domainFromQuery("  https://www.acme.com/careers?x=1 ")).toBe("acme.com");
  expect(domainFromQuery("jobs.acme.co.uk")).toBe("acme.co.uk");
});

it("reads anything else as a name to search for", () => {
  expect(domainFromQuery("")).toBeNull();
  expect(domainFromQuery("Acme")).toBeNull();
  expect(domainFromQuery("Acme Corp.")).toBeNull();
  expect(domainFromQuery("acme.")).toBeNull();
  expect(domainFromQuery("javascript:alert(1)")).toBeNull();
});
