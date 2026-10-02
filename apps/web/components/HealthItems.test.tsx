import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HealthCandidate, HealthItem } from "@/lib/queries/health";

vi.mock("@/app/actions/companies", () => ({
  disableSource: vi.fn(), pasteDiscoveryUrl: vi.fn(), pauseCompany: vi.fn(), rediscoverCompany: vi.fn(),
}));
vi.mock("@/app/actions/health", () => ({
  confirmHealthSource: vi.fn(), keepHealthCurrentSource: vi.fn(), useHealthCandidate: vi.fn(),
}));

import { HealthItems } from "./HealthItems";

const choice = (memberBlock: HealthCandidate["memberBlock"]): HealthCandidate => ({
  index: 0, type: "greenhouse", url: "https://boards.greenhouse.io/acme", confidence: 0.9, method: "homepage", memberBlock,
});
const base = (kind: HealthItem["kind"]): HealthItem => ({
  key: kind, kind, company: { id: "company-id", name: "Acme" }, source: null, memberCanConfirmSource: false,
  runId: null, candidates: [], reason: null, budget: null,
});
const waitingSource = { id: "source-id", type: "greenhouse" as const, url: "https://boards.greenhouse.io/acme", status: "needs_confirmation" as const, consecutiveFailures: 0 };
const markup = (item: HealthItem, isAdmin = false) => renderToStaticMarkup(<HealthItems items={[item]} unverified={false} isAdmin={isAdmin} />);
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map(match => match[1]?.replace(/<[^>]+>/g, "") ?? "");

describe("Health source controls", () => {
  it("keeps safe initial confirmation available to a member", () => {
    const item = { ...base("needs_confirmation"), source: waitingSource, memberCanConfirmSource: true,
      runId: "run-id", candidates: [choice(null)] };
    expect(buttons(markup(item))).toContain("Use this");
    expect(buttons(markup(item))).toContain("Use this source");
  });

  it("explains a replacement boundary to members and keeps both choices for admins", () => {
    const item = { ...base("needs_confirmation"), source: waitingSource, runId: "run-id", candidates: [choice("replace")] };
    const member = markup(item);
    expect(buttons(member)).not.toContain("Use this");
    expect(buttons(member)).not.toContain("Use this source");
    expect(member).toContain("Only an administrator can replace it");
    expect(buttons(member)).toContain("Pause scanning");
    expect(buttons(markup(item, true))).toEqual(expect.arrayContaining(["Use this", "Use this source"]));
  });

  it("explains a switched-off candidate while leaving an admin's choice available", () => {
    const item = { ...base("rediscovery"), runId: "run-id", candidates: [choice("reactivate")] };
    const member = markup(item);
    expect(buttons(member)).not.toContain("Use this");
    expect(member).toContain("Only an administrator can turn it back on");
    expect(buttons(member)).toContain("Keep the current source");
    expect(buttons(markup(item, true))).toContain("Use this");
  });

  it("shows account-safe recovery for a member with a failing source and admin disabling for an admin", () => {
    const item = { ...base("failing"), source: { ...waitingSource, status: "failing" as const, consecutiveFailures: 4 } };
    const member = markup(item);
    expect(buttons(member)).not.toContain("Disable this source");
    expect(member).toContain("Only an administrator can disable this shared source");
    expect(buttons(member)).toEqual(expect.arrayContaining(["Re-discover", "Pause scanning"]));
    expect(buttons(markup(item, true))).toContain("Disable this source");
  });
});
