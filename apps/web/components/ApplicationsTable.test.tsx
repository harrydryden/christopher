// @vitest-environment jsdom
/**
 * The applications table's CV section, in a browser, when the page streams the build prices: the
 * table is there at once, an open row's build control waits under the loading mark until its price
 * arrives, and a budget refusal that arrives with it disables the control.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/app/actions/applications", () => ({ manageRoleCv: vi.fn(), setRoleStage: vi.fn(), updateApplication: vi.fn() }));
vi.mock("@/app/actions/cv", () => ({ requestCv: vi.fn() }));

import { ApplicationsTable, type PipelineCvQuotes } from "./ApplicationsTable";
import type { PipelineRow } from "@/lib/queries/applications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB = "0b9c6a53-6c7f-4d4e-9b1e-3f4c2a1d5e60";
const row: PipelineRow = {
  key: JOB, jobId: JOB, companyId: "5d1c7a2e-0f3b-4a8e-9c6d-2b7e1f4a3c90", companyName: "Acme", companyIcon: null,
  jobTitle: "Operations Manager", jobUrl: null, stage: "shortlisted", application: null, cv: null, archivedCvId: null,
  updatedAt: new Date("2026-09-20T09:00:00Z"),
};

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const text = () => container.textContent ?? "";
const pricing = () => container.querySelector('[aria-label="Pricing the build"]');

it("shows the table at once and prices the open row's build when the stream arrives", async () => {
  let resolve!: (quotes: PipelineCvQuotes) => void;
  const quotes = new Promise<PipelineCvQuotes>((done) => { resolve = done; });
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB} quotes={quotes} emptyState={<p>Nothing</p>} />));
  expect(text()).toContain("Operations Manager");
  expect(pricing()).not.toBeNull();
  expect(text()).not.toContain("Paste a replacement description");

  await act(async () => resolve({ [JOB]: { line: "about $3.10 of your $18.40 left this month", refusal: null } }));
  expect(pricing()).toBeNull();
  expect(text()).toContain("Paste a replacement description");
  expect(text()).toContain("about $3.10 of your $18.40 left this month");
});

it("disables the build when the streamed price carries the budget's refusal", async () => {
  const refusal = "This build would cost about $4.00, more than the $1.00 left of this account's budget.";
  await act(async () => root.render(
    <ApplicationsTable rows={[row]} openKey={JOB} quotes={Promise.resolve({ [JOB]: { line: "about $4.00 of your $1.00 left this month", refusal } })} emptyState={<p>Nothing</p>} />,
  ));
  expect(text()).toContain(refusal);
  const build = [...container.querySelectorAll("button")].find((el) => el.textContent === "Build CV" && el.hasAttribute("aria-describedby"));
  expect(build?.disabled).toBe(true);
});

it("never waits on prices for an account that cannot build yet", async () => {
  const never = new Promise<PipelineCvQuotes>(() => {});
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB} quotes={never} unverified emptyState={<p>Nothing</p>} />));
  expect(pricing()).toBeNull();
  expect(text()).toContain("Confirm");
});
