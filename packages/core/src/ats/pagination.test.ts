import { describe, expect, it } from "vitest";
import { nextListingPage } from "./html";

describe("listing pagination", () => {
  const url = "https://acme.example/careers";
  it("resolves explicit next-page links", () => {
    expect(nextListingPage('<link rel="next" href="?page=2">', url)).toBe("https://acme.example/careers?page=2");
    expect(nextListingPage('<a href="/more" aria-label="Next page">→</a>', url)).toBe("https://acme.example/more");
  });
  it("does not follow off-site, disabled, self or ordinary job links", () => {
    expect(nextListingPage('<a rel="next" href="https://elsewhere.example/jobs">Next</a>', url)).toBeNull();
    expect(nextListingPage('<a rel="next" aria-disabled="true" href="?page=2">Next</a>', url)).toBeNull();
    expect(nextListingPage('<a rel="next" href="#page">Next</a>', url)).toBeNull();
    expect(nextListingPage('<a href="/jobs/one">Operations Manager</a>', url)).toBeNull();
  });
});
