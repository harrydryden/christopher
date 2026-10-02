import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingOverview, PlanReadout, type BillingSummaryView } from "./BillingOverview";

const free: BillingSummaryView = {
  plan: "free",
  status: "active",
  cv: { available: 2, reserved: 1, monthly: 0, welcome: 2, purchased: 0, nextGrantAt: null },
  companies: { active: 18, included: 25, paidBlocks: 0, capacity: 25, technicalMax: 200 },
  renewalAt: null,
  paymentNeedsAttention: false,
};

describe("plan and credit readout", () => {
  it("links a compact, accessible balance to Account", () => {
    const html = renderToStaticMarkup(<PlanReadout billing={free} mobile />);
    expect(html).toContain('href="/account#plan-and-credits"');
    expect(html).toContain("Free · 2 CV credits");
    expect(html).toContain("Open plan and credits");
  });

  it("explains the account's actual allowances and the available packs", () => {
    const html = renderToStaticMarkup(<BillingOverview billing={free} />);
    expect(html).toContain("2 available");
    expect(html).toContain("18 of 25 active");
    expect(html).toContain("First 3 CVs");
    expect(html).toContain("£5");
    expect(html).toContain("£9");
    expect(html).toContain("£15");
    expect(html).not.toContain("$11");
  });

  it("submits the advertised plan and pack identifiers to billing actions", () => {
    const actions = {
      startPlanCheckout: async (_form: FormData) => {},
      startCreditCheckout: async (_form: FormData) => {},
      openBillingPortal: async () => {},
    };
    const html = renderToStaticMarkup(<BillingOverview billing={free} actions={actions} />);
    expect(html).toContain('name="plan" value="search"');
    expect(html).toContain('name="plan" value="intensive"');
    for (const pack of ["cv5", "cv10", "cv20"]) expect(html).toContain(`name="pack" value="${pack}"`);
  });

  it("shows extra monitoring and a payment notice only when relevant", () => {
    const paid: BillingSummaryView = {
      ...free,
      plan: "search",
      monthlyPriceGbp: 30,
      cv: { available: 7, reserved: 0, monthly: 5, welcome: 0, purchased: 2, nextGrantAt: new Date("2026-11-02T00:00:00Z") },
      companies: { active: 105, included: 100, paidBlocks: 1, capacity: 110, technicalMax: 200 },
      renewalAt: new Date("2026-11-02T00:00:00Z"),
      paymentNeedsAttention: true,
    };
    const html = renderToStaticMarkup(<BillingOverview billing={paid} />);
    expect(html).toContain("105 of 110 active");
    expect(html).toContain("10 extra slots");
    expect(html).toContain("£30/month");
    expect(html).toContain("2 November 2026");
    expect(html).toContain('role="alert"');
  });
});
