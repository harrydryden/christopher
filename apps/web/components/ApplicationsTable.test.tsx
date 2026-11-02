// @vitest-environment jsdom
/** Opening a CV application workspace is free; generation is a separate choice there. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/applications", () => ({ manageRoleCv: vi.fn(), setRoleStage: vi.fn(), updateApplication: vi.fn() }));
vi.mock("@/app/actions/cv", () => ({ requestCv: vi.fn() }));
vi.mock("@/app/actions/cv-editing", () => ({ createCvApplicationContext: vi.fn() }));

import { ApplicationsTable, type PipelineCvQuotes } from "./ApplicationsTable";
import { createCvApplicationContext } from "@/app/actions/cv-editing";
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
  vi.clearAllMocks();
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
const pricing = () => container.querySelector('[aria-label="Checking CV credits"]');

it("shows a free workspace entry immediately without waiting for a credit quote", async () => {
  let resolve!: (quotes: PipelineCvQuotes) => void;
  const quotes = new Promise<PipelineCvQuotes>((done) => { resolve = done; });
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB} quotes={quotes} emptyState={<p>Nothing</p>} />));
  expect(text()).toContain("Operations Manager");
  expect(pricing()).toBeNull();
  expect(text()).toContain("Prepare CV · free");
  expect(container.querySelector('textarea[placeholder^="Paste the original advert"]')).not.toBeNull();

  await act(async () => resolve({ [JOB]: { line: "Uses 1 CV credit · 2 remaining", refusal: null } }));
  expect(pricing()).toBeNull();
  expect(text()).toContain("Prepare CV · free");
  expect(text()).toContain("one CV credit only when you request it");
});

it("allows free workspace preparation even when no CV credits remain", async () => {
  const refusal = "No CV credits left. Add credits in Account to build this CV.";
  vi.mocked(createCvApplicationContext).mockResolvedValue({ ok: true, contextId: "context-id", descriptionVersionId: "description-id" });
  await act(async () => root.render(
    <ApplicationsTable rows={[row]} openKey={JOB} quotes={Promise.resolve({ [JOB]: { line: "Uses 1 CV credit · 0 remaining", refusal } })} emptyState={<p>Nothing</p>} />,
  ));
  const prepare = [...container.querySelectorAll("button")].find((el) => el.textContent === "Prepare CV · free")!;
  expect(prepare.disabled).toBe(false);
  await act(async () => prepare.click());
  expect(createCvApplicationContext).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB }));
  expect(router.push).toHaveBeenCalledWith("/cv/context/context-id");
});

it("keeps free preparation available while the credit quote never resolves", async () => {
  const never = new Promise<PipelineCvQuotes>(() => {});
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB} quotes={never} unverified emptyState={<p>Nothing</p>} />));
  expect(pricing()).toBeNull();
  expect(text()).toContain("Prepare CV · free");
});

it("renders one expanded editor inside a mobile card, with its role context", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await act(async () => root.render(<ApplicationsTable rows={[{ ...row, jobUrl: "https://acme.example/job" }]} openKey={JOB}
    quotes={{ [JOB]: { line: "Uses 1 CV credit", refusal: null } }} emptyState={<p>Nothing</p>} />));
  const mobile = container.querySelector('[aria-label="Applications"]')!;
  expect(mobile.textContent).toContain("Operations Manager");
  expect(mobile.textContent).toContain("View vacancy");
  expect(mobile.querySelectorAll("form")).toHaveLength(1);
  expect(mobile.querySelector('textarea[placeholder^="Paste the original advert"]')).not.toBeNull();
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

it("keeps saved next steps and notes in a guided update while their fields are hidden", async () => {
  const existing: PipelineRow = { ...row, stage: "applied", application: {
    id: "7ad5b760-26fb-4f30-b472-432bd33d6e6a", status: "applied", appliedOn: "2026-09-15", cvId: null,
    notes: "Spoke to recruiter", history: [], nextAction: "Send references", nextActionOn: "2026-10-08", hasPdf: false,
  } };
  await act(async () => root.render(<ApplicationsTable rows={[existing]} quotes={{}} emptyState={<p>Nothing</p>} />));
  const update = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Update")!;
  act(() => update.click());
  const form = container.querySelector<HTMLFormElement>('form[id^="application-status-"]')!;
  expect(form.parentElement?.textContent).toContain("What happened?");
  expect(form.querySelector('input[name="nextAction"]')?.closest('[hidden]')).not.toBeNull();
  expect(new FormData(form).get("nextAction")).toBe("Send references");
  expect(new FormData(form).get("nextActionOn")).toBe("2026-10-08");
  expect(new FormData(form).get("notes")).toBe("Spoke to recruiter");
  const next = [...form.querySelectorAll<HTMLButtonElement>('button[type="button"]')].find(button => button.textContent === "Edit next step")!;
  act(() => next.click());
  const field = form.querySelector<HTMLInputElement>('input[name="nextAction"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Call recruiter"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => [...form.querySelectorAll<HTMLButtonElement>('button[type="button"]')].find(button => button.textContent === "Hide next step")!.click());
  expect(new FormData(form).get("nextAction")).toBe("Call recruiter");
});

it("opens the saved CV workspace with revision details as secondary text", async () => {
  const withCv: PipelineRow = { ...row, cv: { id: "ad83a8ec-771b-43ed-a2bd-71cde1bf88c1", status: "ready", revision: 14,
    finalisedAt: new Date("2026-09-20T09:00:00Z"), createdAt: new Date("2026-09-19T09:00:00Z") } };
  await act(async () => root.render(<ApplicationsTable rows={[withCv]} quotes={{}} emptyState={<p>Nothing</p>} />));
  const link = container.querySelector<HTMLAnchorElement>(`a[href="/cv/${withCv.cv!.id}"]`)!;
  expect(link.textContent).toBe("Open CV workspace");
  expect(link.parentElement?.textContent).toContain("V14 · finalised");
});

it("does not close an edited application without an explicit discard", async () => {
  vi.stubGlobal("confirm", vi.fn(() => false));
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB} quotes={{}} emptyState={<p>Nothing</p>} />));
  const notes = container.querySelector<HTMLTextAreaElement>('textarea[name="notes"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(notes, "Call tomorrow"); notes.dispatchEvent(new Event("input", { bubbles: true })); });
  const title = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Operations Manager")!;
  act(() => title.click());
  expect(container.querySelector('form[id^="application-status-"]')).not.toBeNull();
  expect(notes.value).toBe("Call tomorrow");
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("unsaved changes"));
});

it("preserves a pasted advert and request key across a failed free workspace attempt", async () => {
  vi.mocked(createCvApplicationContext).mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({ ok: true, contextId: "context-id", descriptionVersionId: "description-id" });
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB}
    quotes={{ [JOB]: { line: "Uses 1 CV credit · 2 remaining", refusal: null } }} emptyState={<p>Nothing</p>} />));
  const textarea = container.querySelector('textarea[placeholder^="Paste the original advert"]') as HTMLTextAreaElement;
  const change = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  change("First pasted advert");
  const prepare = [...container.querySelectorAll("button")].find((el) => el.textContent === "Prepare CV · free")!;
  await act(async () => prepare.click());
  expect(textarea.value).toBe("First pasted advert");
  expect(text()).toContain("Your pasted description is still here");
  await act(async () => prepare.click());
  expect(createCvApplicationContext).toHaveBeenCalledTimes(2);
  const first = vi.mocked(createCvApplicationContext).mock.calls[0]![0];
  const second = vi.mocked(createCvApplicationContext).mock.calls[1]![0];
  expect(first).toMatchObject({ jobId: JOB, description: "First pasted advert" });
  expect(second.requestKey).toBe(first.requestKey);
  expect(router.push).toHaveBeenCalledWith("/cv/context/context-id");
});
