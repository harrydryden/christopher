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
import { setRoleStage } from "@/app/actions/applications";
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
  expect(text()).not.toContain("new Auto generation uses one CV credit");
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

it("renders one named application task on mobile, with its role context", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await act(async () => root.render(<ApplicationsTable rows={[{ ...row, jobUrl: "https://acme.example/job" }]} openKey={JOB}
    quotes={{ [JOB]: { line: "Uses 1 CV credit", refusal: null } }} emptyState={<p>Nothing</p>} />));
  const mobile = container.querySelector('[aria-label="Application: Operations Manager"]')!;
  expect(mobile.textContent).toContain("Operations Manager");
  expect(mobile.textContent).toContain("View vacancy");
  expect(mobile.querySelectorAll("form")).toHaveLength(1);
  expect(mobile.querySelector('textarea[placeholder^="Paste the original advert"]')).not.toBeNull();
  expect(container.querySelector('table')).toBeNull();
  expect(mobile.textContent).toContain("Back to applications");
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

it("keeps saved next steps and notes directly editable without disclosure controls", async () => {
  const existing: PipelineRow = { ...row, stage: "applied", application: {
    id: "7ad5b760-26fb-4f30-b472-432bd33d6e6a", status: "applied", appliedOn: "2026-09-15", cvId: null,
    notes: "Spoke to recruiter", history: [], nextAction: "Send references", nextActionOn: "2026-10-08", hasPdf: false,
  } };
  await act(async () => root.render(<ApplicationsTable rows={[existing]} quotes={{}} emptyState={<p>Nothing</p>} />));
  const update = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Update")!;
  act(() => update.click());
  const form = container.querySelector<HTMLFormElement>('form[id^="application-status-"]')!;
  expect(form.parentElement?.textContent).toContain("What happened?");
  expect(form.querySelector('input[name="nextAction"]')?.closest('[hidden]')).toBeNull();
  expect(new FormData(form).get("nextAction")).toBe("Send references");
  expect(new FormData(form).get("nextActionOn")).toBe("2026-10-08");
  expect(new FormData(form).get("notes")).toBe("Spoke to recruiter");
  const field = form.querySelector<HTMLInputElement>('input[name="nextAction"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Call recruiter"); field.dispatchEvent(new Event("input", { bubbles: true })); });
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
  const back = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Back to applications")!;
  act(() => back.click());
  expect(container.querySelector('form[id^="application-status-"]')).not.toBeNull();
  expect(notes.value).toBe("Call tomorrow");
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("unsaved changes"));
});

it("protects an edited application across route filters and unload without intercepting a new tab or hash", async () => {
  const originalUrl = window.location.href;
  window.history.replaceState({}, "", "/applications?filter=all");
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB} quotes={{}} emptyState={<p>Nothing</p>} />));
  const notes = container.querySelector<HTMLTextAreaElement>('textarea[name="notes"]')!;
  act(() => {
    notes.value = "Call tomorrow";
    notes.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const link = document.createElement("a");
  link.href = "/applications?filter=due";
  document.body.append(link);
  let arrived = 0;
  link.addEventListener("click", event => { arrived += 1; event.preventDefault(); });
  const click = (options: MouseEventInit = {}) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...options });
    link.dispatchEvent(event);
    return event;
  };
  try {
    expect(click().defaultPrevented).toBe(true);
    expect(arrived).toBe(0);
    expect(notes.value).toBe("Call tomorrow");
    expect(confirm).toHaveBeenCalledTimes(1);

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    link.target = "_blank";
    click();
    expect(arrived).toBe(1);
    link.target = "";
    click({ metaKey: true });
    expect(arrived).toBe(2);
    link.download = "applications.csv";
    click();
    expect(arrived).toBe(3);
    link.removeAttribute("download");
    link.href = `${window.location.pathname}${window.location.search}#status`;
    click();
    expect(arrived).toBe(4);
    expect(confirm).toHaveBeenCalledTimes(1);

    link.href = "/applications?filter=due";
    confirm.mockReturnValue(true);
    click();
    expect(arrived).toBe(5);
    expect(notes.value).toBe("Call tomorrow");
    // Acceptance only permits the link. If navigation fails, the form is still protected.
    confirm.mockReturnValue(false);
    click();
    expect(arrived).toBe(5);
    expect(confirm).toHaveBeenCalledTimes(3);
  } finally { link.remove(); window.history.replaceState({}, "", originalUrl); }
});

it("keeps edits made during a pending status save protected after success", async () => {
  let finish!: (result: { ok: true }) => void;
  vi.mocked(setRoleStage).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal("confirm", vi.fn(() => false));
  await act(async () => root.render(<ApplicationsTable rows={[row]} openKey={JOB} quotes={{}} emptyState={<p>Nothing</p>} />));
  const form = container.querySelector<HTMLFormElement>('form[id^="application-status-"]')!;
  const notes = form.querySelector<HTMLTextAreaElement>('textarea[name="notes"]')!;
  act(() => {
    notes.value = "First note";
    notes.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(setRoleStage).toHaveBeenCalledTimes(1);
  act(() => {
    notes.value = "Second note";
    notes.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => finish({ ok: true }));
  const back = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Back to applications")!;
  act(() => back.click());
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("unsaved changes"));
  expect(notes.value).toBe("Second note");
  expect(container.querySelector('form[id^="application-status-"]')).not.toBeNull();
});

it("opens a named task from the title and returns to the list without an accordion row", async () => {
  await act(async () => root.render(<ApplicationsTable rows={[row]} quotes={{}} emptyState={<p>Nothing</p>} />));
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Operations Manager")!.click());
  expect(container.querySelector('[aria-label="Application: Operations Manager"]')).not.toBeNull();
  expect(container.querySelector("table")).toBeNull();
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Back to applications")!.click());
  expect(container.querySelector("table")).not.toBeNull();
  expect(container.querySelector('[aria-label="Application: Operations Manager"]')).toBeNull();
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
