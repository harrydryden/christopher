// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CareerWorkspace } from "@col/core/career-record";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/career", () => ({ saveCareerChange: vi.fn(), undoCareerChange: vi.fn() }));
import { saveCareerChange, undoCareerChange } from "@/app/actions/career";
import { CareerRecordEditor } from "./CareerRecordEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = "8af5c7c8-f98f-44f8-984a-6389df14b738";
const fields = { title: "Programme lead", originalNarrative: "Led an international service team.",
  dates: { start: "2021", end: null, current: true }, arrangement: "fractional" as const,
  publicLabel: null, confidential: false, industries: ["Healthcare"] };
const provenance = { kind: "direct_user" as const, sourceId: null, quote: null,
  originalText: "Programme lead", captureContext: null };
const summary = { id, kind: "engagement" as const, revision: 1, title: fields.title,
  dates: fields.dates, publicLabel: null, confidential: false, archived: false,
  updatedAt: "2026-11-11T09:00:00Z" };
const workspace: CareerWorkspace = { revision: 2, nextCursor: null, conflicts: [], skillChoices: [],
  records: [summary],
  selected: { effectiveConfidential: false, record: { id, kind: "engagement", revision: 1, fields, provenance, archived: false,
    createdAt: "2026-11-11T09:00:00Z", updatedAt: "2026-11-11T09:00:00Z" }, assertions: [], links: [], perspectives: [], changes: [],
    assertionsNextCursor: null, linksNextCursor: null, changesNextCursor: null } };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("shows direct factual capture without a second confirmation gate", () => {
  const html = renderToStaticMarkup(<CareerRecordEditor workspace={workspace} />);
  expect(html).toContain("Your original story");
  expect(html).toContain("Contributions and facts");
  expect(html).toContain("Save detail · free");
  expect(html).not.toContain("Confirm all");
  expect(html).not.toContain("0 of 1 confirmed");
  expect(html).not.toContain("<details");
});

it("keeps an unsaved detail while opening named perspectives and history tasks", () => {
  act(() => root.render(<CareerRecordEditor workspace={workspace} />));
  const detail = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")].find(input =>
    input.placeholder === "What did you do or achieve?")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(detail, "Retained work detail");
    detail.dispatchEvent(new Event("input", { bubbles: true })); });
  const nav = container.querySelector('nav[aria-label="Experience tasks"]')!;
  act(() => [...nav.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Perspectives")!.click());
  expect(detail.closest("div[hidden]")).not.toBeNull();
  act(() => [...nav.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "History and recovery")!.click());
  act(() => [...nav.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Edit record")!.click());
  expect(detail.value).toBe("Retained work detail");
  expect(saveCareerChange).not.toHaveBeenCalled();
});

it("adds an atomic, reusable skill label with its skill facet", async () => {
  vi.mocked(saveCareerChange).mockResolvedValue({ ok: true, revision: 3,
    changeId: "34eae989-096a-4134-b740-e975c2c050e9", changedIds: [id], conflicts: [] });
  const skillWorkspace: CareerWorkspace = { ...workspace, skillChoices: ["Planning, delivery"],
    selected: { ...workspace.selected!, record: { ...workspace.selected!.record, kind: "skill" } } };
  act(() => root.render(<CareerRecordEditor workspace={skillWorkspace} />));
  expect(container.textContent).not.toContain("From (year or year-month)");
  expect(container.textContent).not.toContain("Industries (optional)");
  expect(container.textContent).toContain("Supporting notes (optional)");
  const choice = container.querySelector<HTMLButtonElement>('button[aria-label="Add Planning, delivery"]')!;
  await act(async () => choice.click());
  expect(saveCareerChange).toHaveBeenCalledWith(expect.objectContaining({ operations: [expect.objectContaining({
    type: "add_assertion", subjectId: id, text: "Planning, delivery", facets: ["skill"] })] }));
  expect(container.textContent).not.toContain("Save detail · free");
});

it("shows public wording instead of skill tags when a linked client makes the record private", () => {
  const html = renderToStaticMarkup(<CareerRecordEditor workspace={{ ...workspace, skillChoices: ["Planning"],
    selected: { ...workspace.selected!, effectiveConfidential: true,
      record: { ...workspace.selected!.record, kind: "skill" } } }} />);
  expect(html).toContain("CV wording (optional)");
  expect(html).toContain("Public label");
  expect(html).not.toContain("Skills in this area");
});

it("shows title search and independent paging for a lifelong record", () => {
  const html = renderToStaticMarkup(<CareerRecordEditor workspace={{ ...workspace,
    nextCursor: "2026-11-11T09:00:00Z|8af5c7c8-f98f-44f8-984a-6389df14b738",
    selected: { ...workspace.selected!, assertionsNextCursor: "a768cd2a-9586-4855-8096-9999ce9b2eaa",
      linksNextCursor: "9ed80928-8a2f-4194-a4d6-5ea92cfd8ad4", changesNextCursor: 12 } }} initialQuery="Programme" />);
  expect(html).toContain("Find in Experience");
  expect(html).toContain("Older records");
  expect(html).toContain("query=Programme");
  expect(html).toContain("Older facts");
  expect(html).toContain("Older links");
  expect(html).toContain("Older changes");
});

it("saves a record change on blur, reports acknowledgement, and offers real Undo", async () => {
  vi.mocked(saveCareerChange).mockResolvedValue({ ok: true, revision: 3, changeId: "34eae989-096a-4134-b740-e975c2c050e9", changedIds: [id], conflicts: [] });
  vi.mocked(undoCareerChange).mockResolvedValue({ ok: true, revision: 4, changeId: "52f90b12-c346-4f30-911b-c4cc6883a72f", changedIds: [id], conflicts: [] });
  act(() => root.render(<CareerRecordEditor workspace={workspace} />));
  const field = [...container.querySelectorAll<HTMLInputElement>("input")].find(input => input.value === "Programme lead")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "Fractional programme lead");
    field.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.textContent).toContain("Unsaved changes");
  await act(async () => field.dispatchEvent(new Event("focusout", { bubbles: true })));
  expect(saveCareerChange).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2,
    operations: [expect.objectContaining({ type: "edit_record", id, expectedRevision: 1,
      fields: expect.objectContaining({ title: "Fractional programme lead" }) })] }));
  expect(container.textContent).toContain("Saved");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Undo last change")!.click());
  expect(undoCareerChange).toHaveBeenCalledWith(expect.objectContaining({
    changeId: "34eae989-096a-4134-b740-e975c2c050e9", expectedRevision: 3 }));
});

it("keeps an unsaved edit after a failed write and retries the same intent", async () => {
  vi.mocked(saveCareerChange).mockResolvedValueOnce({ ok: false, error: "Please retry." })
    .mockResolvedValueOnce({ ok: true, revision: 3, changeId: "34eae989-096a-4134-b740-e975c2c050e9", changedIds: [id], conflicts: [] });
  act(() => root.render(<CareerRecordEditor workspace={workspace} />));
  const field = [...container.querySelectorAll<HTMLInputElement>("input")].find(input => input.value === "Programme lead")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "My retained title");
    field.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => field.dispatchEvent(new Event("focusout", { bubbles: true })));
  expect(field.value).toBe("My retained title");
  expect(container.textContent).toContain("Please retry.");
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button =>
    button.textContent === "Retry save")!.click());
  const calls = vi.mocked(saveCareerChange).mock.calls;
  expect(calls[0]?.[0].requestKey).toBe(calls[1]?.[0].requestKey);
  expect(container.textContent).toContain("Saved");
});

it("keeps a dirty record pinned when a different record is selected", async () => {
  vi.mocked(saveCareerChange).mockResolvedValue({ ok: true, revision: 4,
    changeId: "34eae989-096a-4134-b740-e975c2c050e9", changedIds: [id], conflicts: [] });
  act(() => root.render(<CareerRecordEditor workspace={workspace} />));
  const field = [...container.querySelectorAll<HTMLInputElement>("input")].find(input => input.value === "Programme lead")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "My unsaved role");
    field.dispatchEvent(new Event("input", { bubbles: true })); });
  const otherId = "1918f6c3-3020-4638-9bd1-50116713e291";
  const other = { ...workspace.selected!.record, id: otherId, fields: { ...fields, title: "Different role" } };
  act(() => root.render(<CareerRecordEditor workspace={{ ...workspace, revision: 3,
    selected: { ...workspace.selected!, record: other }, records: [...workspace.records,
      { ...summary, id: otherId, title: "Different role" }] }} />));
  expect(field.value).toBe("My unsaved role");
  expect(container.textContent).toContain("Your work remains attached to Programme lead");
  await act(async () => field.dispatchEvent(new Event("focusout", { bubbles: true })));
  expect(saveCareerChange).toHaveBeenCalledWith(expect.objectContaining({ operations: [expect.objectContaining({
    type: "edit_record", id, fields: expect.objectContaining({ title: "My unsaved role" }) })] }));
});

it("allows saving a drafted detail without treating that draft as a conflicting edit", async () => {
  vi.mocked(saveCareerChange).mockResolvedValue({ ok: true, revision: 3,
    changeId: "34eae989-096a-4134-b740-e975c2c050e9", changedIds: [id], conflicts: [] });
  act(() => root.render(<CareerRecordEditor workspace={workspace} />));
  const field = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")].find(input => input.placeholder === "What did you do or achieve?")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Reduced handoff delays");
    field.dispatchEvent(new Event("input", { bubbles: true })); });
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save detail · free")!;
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(saveCareerChange).toHaveBeenCalledWith(expect.objectContaining({ operations: [expect.objectContaining({
    type: "add_assertion", subjectId: id, text: "Reduced handoff delays" })] }));
});

it("queues a second field edit behind the first save and uses the acknowledged revisions", async () => {
  let finishFirst!: (result: Awaited<ReturnType<typeof saveCareerChange>>) => void;
  vi.mocked(saveCareerChange).mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockResolvedValueOnce({ ok: true, revision: 4, changeId: "52f90b12-c346-4f30-911b-c4cc6883a72f", changedIds: [id], conflicts: [] });
  act(() => root.render(<CareerRecordEditor workspace={workspace} />));
  const field = [...container.querySelectorAll<HTMLInputElement>("input")].find(input => input.value === "Programme lead")!;
  function type(value: string) { act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true })); }); }
  type("First change");
  await act(async () => { field.dispatchEvent(new Event("focusout", { bubbles: true })); });
  type("Second change");
  await act(async () => { field.dispatchEvent(new Event("focusout", { bubbles: true })); });
  expect(saveCareerChange).toHaveBeenCalledTimes(1);
  await act(async () => { finishFirst({ ok: true, revision: 3,
    changeId: "34eae989-096a-4134-b740-e975c2c050e9", changedIds: [id], conflicts: [] });
    await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  const calls = vi.mocked(saveCareerChange).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1]?.[0]).toMatchObject({ expectedRevision: 3,
    operations: [{ type: "edit_record", id, expectedRevision: 2, fields: { title: "Second change" } }] });
});

it("retains a later fact edit made while the first one is saving", async () => {
  const assertionId = "a768cd2a-9586-4855-8096-9999ce9b2eaa";
  const fact = { id: assertionId, subjectId: id, revision: 1, text: "Coordinated releases", publicText: null,
    facets: [], status: "usable" as const, provenance: { ...provenance, originalText: "Coordinated releases" },
    context: null, createdAt: "2026-11-11T09:00:00Z", updatedAt: "2026-11-11T09:00:00Z" };
  let finishFirst!: (result: Awaited<ReturnType<typeof saveCareerChange>>) => void;
  vi.mocked(saveCareerChange).mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockResolvedValueOnce({ ok: true, revision: 4, changeId: "52f90b12-c346-4f30-911b-c4cc6883a72f", changedIds: [assertionId], conflicts: [] });
  act(() => root.render(<CareerRecordEditor workspace={{ ...workspace,
    selected: { ...workspace.selected!, assertions: [fact] } }} />));
  const field = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")].find(input => input.value === fact.text)!;
  function type(value: string) { act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true })); }); }
  type("Coordinated weekly releases");
  await act(async () => { field.dispatchEvent(new Event("focusout", { bubbles: true })); });
  type("Coordinated weekly releases across regions");
  await act(async () => { field.dispatchEvent(new Event("focusout", { bubbles: true })); });
  await act(async () => { finishFirst({ ok: true, revision: 3,
    changeId: "34eae989-096a-4134-b740-e975c2c050e9", changedIds: [assertionId], conflicts: [] });
    await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  expect(field.value).toBe("Coordinated weekly releases across regions");
  expect(vi.mocked(saveCareerChange).mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 3,
    operations: [{ type: "edit_assertion", id: assertionId, expectedRevision: 2,
      text: "Coordinated weekly releases across regions" }] });
});

it("keeps drafted public wording visible when privacy is switched off", () => {
  act(() => root.render(<CareerRecordEditor workspace={{ ...workspace,
    selected: { ...workspace.selected!, effectiveConfidential: true, record: { ...workspace.selected!.record,
      fields: { ...fields, confidential: true } } } }} />));
  const wording = container.querySelector<HTMLInputElement>('input[maxlength="4000"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(wording, "Public-safe description");
    wording.dispatchEvent(new Event("input", { bubbles: true })); });
  const privacy = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(input =>
    input.parentElement?.textContent?.includes("Keep private identity"))!;
  act(() => privacy.click());
  expect(container.querySelector<HTMLInputElement>('input[maxlength="4000"]')?.value).toBe("Public-safe description");
});
