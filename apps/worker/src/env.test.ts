/** The worker's environment: what production refuses, and what it records on the way up. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnv } from "./env";

const BASE = { DATABASE_URL: "postgres://postgres@127.0.0.1:5432/ava_test" };
const PRODUCTION = { ...BASE, NODE_ENV: "production", ADMIN_EMAILS: "owner@ava.dev" };

function captured() {
  const lines: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const keep = (chunk: unknown) => {
    try { lines.push(JSON.parse(String(chunk))); } catch { /* not one of ours */ }
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(keep);
  vi.spyOn(process.stderr, "write").mockImplementation(keep);
  return lines;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("SCRAPER_CONTACT_EMAIL", () => {
  it("defaults outside production, so tests and local runs need nothing set", () => {
    expect(readEnv(BASE).contactEmail).toBe("unknown@example.com");
    expect(readEnv({ ...BASE, SCRAPER_CONTACT_EMAIL: " me@example.com " }).contactEmail).toBe("me@example.com");
  });

  it.each([undefined, "", "   ", "not-an-address", "you@example.com", "ops@EXAMPLE.org", "ops@crawler.example", "ops@corp.test", "me@host.local"])(
    "is refused in production when it is %j",
    value => {
      captured();
      expect(() => readEnv({ ...PRODUCTION, SCRAPER_CONTACT_EMAIL: value })).toThrow(/SCRAPER_CONTACT_EMAIL must be a real address/);
    },
  );

  it("is used as given in production when it is a real address", () => {
    captured();
    expect(readEnv({ ...PRODUCTION, SCRAPER_CONTACT_EMAIL: "crawler@ava.dev" }).contactEmail).toBe("crawler@ava.dev");
  });
});

describe("the production boot line", () => {
  it("records concurrency, the pool ceiling and the heap limit", () => {
    const lines = captured();
    const env = readEnv({ ...PRODUCTION, SCRAPER_CONTACT_EMAIL: "crawler@ava.dev", WORKER_CONCURRENCY: "3" });
    // Three general slots and the default eight CV slots, two connections each, and a margin.
    expect(env.cvConcurrency).toBe(8);
    expect(env.databasePoolMax).toBe(26);
    const boot = lines.find(line => line.msg === "worker environment");
    expect(boot?.level).toBe("info");
    expect(boot?.data).toMatchObject({ concurrency: 3, cvConcurrency: 8, browserConcurrency: 1, databasePoolMax: 26 });
    expect(boot?.data?.heapLimitMb).toBeGreaterThan(0);
    expect(lines.some(line => line.level === "warn")).toBe(false);
  });

  it("warns when ADMIN_EMAILS is unset, and says nothing outside production", () => {
    const lines = captured();
    readEnv({ ...PRODUCTION, ADMIN_EMAILS: " ", SCRAPER_CONTACT_EMAIL: "crawler@ava.dev" });
    expect(lines.filter(line => line.level === "warn").map(line => line.msg)).toEqual([expect.stringMatching(/^ADMIN_EMAILS is unset/)]);
    lines.length = 0;
    readEnv(BASE);
    expect(lines).toEqual([]);
  });

  it("sizes the pool from both kinds of slot", () => {
    expect(readEnv({ ...BASE, WORKER_CONCURRENCY: "6" }).databasePoolMax).toBe(32);
    expect(readEnv({ ...BASE, WORKER_CONCURRENCY: "3", CV_CONCURRENCY: "1" }).databasePoolMax).toBe(12);
  });

  it("bounds the CV slots from one to thirty", () => {
    expect(readEnv({ ...BASE, CV_CONCURRENCY: "30" }).cvConcurrency).toBe(30);
    expect(() => readEnv({ ...BASE, CV_CONCURRENCY: "0" })).toThrow(/1–30/);
    expect(() => readEnv({ ...BASE, CV_CONCURRENCY: "31" })).toThrow(/1–30/);
  });
});
