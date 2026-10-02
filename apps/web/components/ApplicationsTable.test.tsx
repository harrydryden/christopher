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
vi.mock("@/app/actions/cv", () => ({ requestCv: vi.fn(), quoteCvBuild: vi.fn() }));

import { ApplicationsTable, type PipelineCvQuotes } from "./ApplicationsTable";
import { quoteCvBuild } from "@/app/actions/cv";
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
  vi.unstubAllGlobals();
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

it("renders one expanded editor inside a mobile card, with its role context", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await act(async () => root.render(<ApplicationsTable rows={[{ ...row, jobUrl: "https://acme.example/job" }]} openKey={JOB}
    quotes={{ [JOB]: { line: "about $3.10", refusal: null } }} emptyState={<p>Nothing</p>} />));
  const mobile = container.querySelector('[aria-label="Applications"]')!;
  expect(mobile.textContent).toContain("Operations Manager");
  expect(mobile.textContent).toContain("View vacancy");
  expect(mobile.querySelectorAll("form")).toHaveLength(2);
  expect(container.querySelectorAll(`#application-${JOB}`)).toHaveLength(1);
});

it("does not carry an untouched Applied date into a later status", async () => {
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB} quotes={{}} unverified emptyState={<p>Nothing</p>} />));
  const select = container.querySelector('select[name="status"]') as HTMLSelectElement;
  const choose = (status: string) => act(() => { select.value = status; select.dispatchEvent(new Event("change", { bubbles: true })); });
  choose("applied");
  const date = container.querySelector('input[name="appliedOn"]') as HTMLInputElement;
  expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  choose("interview");
  expect((container.querySelector('input[name="appliedOn"]') as HTMLInputElement).value).toBe("");
  const edited = container.querySelector('input[name="appliedOn"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(edited, "2026-09-03");
    edited.dispatchEvent(new Event("input", { bubbles: true }));
    edited.dispatchEvent(new Event("change", { bubbles: true }));
  });
  choose("applied");
  choose("interview");
  expect((container.querySelector('input[name="appliedOn"]') as HTMLInputElement).value).toBe("2026-09-03");
});

it("prices the exact pasted advert before enabling its build and ignores a stale price", async () => {
  let first!: (value: { ok: true; line: string; refusal: null }) => void;
  vi.mocked(quoteCvBuild)
    .mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
    .mockResolvedValueOnce({ ok: true, line: "about $5.20 of $18.40 left", refusal: null });
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB}
    quotes={{ [JOB]: { line: "about $3.10 of $18.40 left", refusal: null } }} emptyState={<p>Nothing</p>} />));
  const textarea = container.querySelector('textarea[name="description"]') as HTMLTextAreaElement;
  const change = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  change("First pasted advert");
  const build = [...container.querySelectorAll("button")].find((el) => el.textContent === "Build CV" && el.type === "submit")!;
  expect(build.disabled).toBe(true);
  const check = () => [...container.querySelectorAll("button")].find((el) => el.textContent?.includes("Check pasted advert estimate") || el.textContent?.includes("Check estimate again"))!;
  await act(async () => { check().click(); });
  change("Second pasted advert, longer");
  await act(async () => { first({ ok: true, line: "about $2.00 stale", refusal: null }); });
  expect(text()).not.toContain("stale");
  expect(build.disabled).toBe(true);
  await act(async () => { check().click(); });
  expect(vi.mocked(quoteCvBuild)).toHaveBeenLastCalledWith(JOB, "Second pasted advert, longer");
  expect(text()).toContain("Pasted advert estimate: about $5.20");
  expect(build.disabled).toBe(false);
});
