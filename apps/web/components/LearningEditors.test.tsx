// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReasonTagEditor } from "./ReasonTagEditor";
import { OpenQuestionEditors } from "./OpenQuestionEditors";
import { LearningProfileEditor } from "./LearningProfileEditor";
import type { ActionResult } from "@/lib/validation";

vi.mock("@/app/actions/decisions", () => ({ saveDecisionTagsSetting: vi.fn() }));
vi.mock("@/app/actions/learning", () => ({ answerOpenQuestionSetting: vi.fn() }));
import { saveDecisionTagsSetting } from "@/app/actions/decisions";
import { answerOpenQuestionSetting } from "@/app/actions/learning";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.resetAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function submit() { container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); }
function checkbox(value: string) { return container.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${value}"]`)!; }
function typeAnswer(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[name="answer"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function typeProfile(value: string) {
  const input = container.querySelector<HTMLTextAreaElement>('textarea[name="markdown"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("updates a pristine profile text and version together after a sibling refresh", async () => {
  const action = vi.fn(async (_previous: ActionResult, _data: FormData): Promise<ActionResult> => ({ ok: false, error: "stale" }));
  const editor = (text: string, version: number) => <LearningProfileEditor action={action} name="markdown" id="profile" label="Preferences"
    text={text} version={version} rows={3} disabled={false} submitLabel="Save profile" />;
  await act(async () => root.render(editor("Old profile", 1)));
  await act(async () => root.render(editor("New profile", 2)));
  expect(container.querySelector<HTMLTextAreaElement>('textarea[name="markdown"]')?.value).toBe("New profile");
  await act(async () => { typeProfile("My change to new profile"); submit(); });
  expect(action.mock.calls[0]![1].get("profileVersion")).toBe("2");
  expect(action.mock.calls[0]![1].get("markdown")).toBe("My change to new profile");
});

it("keeps a dirty profile pair through refresh and advances pending edits only to its own save", async () => {
  let resolve!: (result: { ok: true; nextSnapshot: { profileVersion: string } }) => void;
  const action = vi.fn((_previous: unknown, _data: FormData) =>
    action.mock.calls.length === 1 ? new Promise<{ ok: true; nextSnapshot: { profileVersion: string } }>(done => { resolve = done; })
      : Promise.resolve({ ok: false as const, error: "stale" }));
  const editor = (text: string, version: number) => <LearningProfileEditor action={action} name="markdown" id="profile" label="Preferences"
    text={text} version={version} rows={3} disabled={false} submitLabel="Save profile" />;
  await act(async () => root.render(editor("Old profile", 1)));
  await act(async () => typeProfile("My draft"));
  await act(async () => root.render(editor("Other profile", 2)));
  expect(container.querySelector<HTMLTextAreaElement>('textarea[name="markdown"]')?.value).toBe("My draft");
  act(() => submit());
  await act(async () => typeProfile("My newer draft"));
  await act(async () => resolve({ ok: true, nextSnapshot: { profileVersion: "2" } }));
  await act(async () => root.render(editor("Third profile", 3)));
  await act(async () => submit());
  expect(action.mock.calls[0]![1].get("profileVersion")).toBe("1");
  expect(action.mock.calls[1]![1].get("profileVersion")).toBe("2");
  expect(container.querySelector<HTMLTextAreaElement>('textarea[name="markdown"]')?.value).toBe("My newer draft");
});

it("keeps checked tags and guard paired on a pristine refresh, then across two saves", async () => {
  const save = vi.mocked(saveDecisionTagsSetting);
  save.mockImplementation(async (_id, _previous, data) => ({ ok: true, nextSnapshot: { expectedTags: JSON.stringify({ tags: data.getAll("tags"), tagsEdited: true }) } }));
  const options = [{ tag: "remote" }, { tag: "leadership" }];
  const editor = (tags: string[], tagsEdited: boolean) => <ReasonTagEditor decisionId="decision-1" tags={tags} tagsEdited={tagsEdited} options={options} disabled={false} />;
  await act(async () => root.render(editor([], false)));
  await act(async () => root.render(editor(["remote"], true)));
  expect(checkbox("remote").checked).toBe(true);
  await act(async () => { checkbox("leadership").click(); submit(); });
  expect(save.mock.calls[0]![2].get("expectedTags")).toBe(JSON.stringify({ tags: ["remote"], tagsEdited: true }));
  expect(save.mock.calls[0]![2].getAll("tags").sort()).toEqual(["leadership", "remote"]);
  expect(checkbox("remote").checked).toBe(true);
  expect(checkbox("leadership").checked).toBe(true);
  await act(async () => { checkbox("leadership").click(); submit(); });
  expect(save.mock.calls[1]![2].get("expectedTags")).toBe(JSON.stringify({ tags: ["remote", "leadership"], tagsEdited: true }));
  expect(save.mock.calls[1]![2].getAll("tags")).toEqual(["remote"]);
});

it("keeps a dirty tag selection and original guard when server props refresh", async () => {
  vi.mocked(saveDecisionTagsSetting).mockResolvedValue({ ok: false, error: "Tags changed." });
  const options = [{ tag: "remote" }, { tag: "leadership" }];
  const editor = (tags: string[], tagsEdited: boolean) => <ReasonTagEditor decisionId="decision-1" tags={tags} tagsEdited={tagsEdited} options={options} disabled={false} />;
  await act(async () => root.render(editor([], false)));
  await act(async () => checkbox("leadership").click());
  await act(async () => root.render(editor(["remote"], true)));
  expect(checkbox("leadership").checked).toBe(true);
  expect(checkbox("remote").checked).toBe(false);
  await act(async () => submit());
  expect(vi.mocked(saveDecisionTagsSetting).mock.calls[0]![2].get("expectedTags")).toBe(JSON.stringify({ tags: [], tagsEdited: false }));
});

it("keeps newer tag edits made during a save and advances only to that save's guard", async () => {
  let resolve!: (result: { ok: true; nextSnapshot: { expectedTags: string } }) => void;
  const save = vi.mocked(saveDecisionTagsSetting);
  save.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  save.mockImplementation(async (_id, _previous, data) => ({ ok: true, nextSnapshot: { expectedTags: JSON.stringify({ tags: data.getAll("tags"), tagsEdited: true }) } }));
  await act(async () => root.render(<ReasonTagEditor decisionId="decision-1" tags={[]} tagsEdited={false}
    options={[{ tag: "remote" }, { tag: "leadership" }]} disabled={false} />));
  act(() => { checkbox("remote").click(); submit(); });
  await act(async () => checkbox("leadership").click());
  await act(async () => resolve({ ok: true, nextSnapshot: { expectedTags: JSON.stringify({ tags: ["remote"], tagsEdited: true }) } }));
  expect(checkbox("remote").checked).toBe(true);
  expect(checkbox("leadership").checked).toBe(true);
  await act(async () => submit());
  expect(save.mock.calls[1]![2].get("expectedTags")).toBe(JSON.stringify({ tags: ["remote"], tagsEdited: true }));
  expect(save.mock.calls[1]![2].getAll("tags").sort()).toEqual(["leadership", "remote"]);
});

it("retains a typed answer and original guard when a sibling refresh answers or removes the question", async () => {
  vi.mocked(answerOpenQuestionSetting).mockResolvedValue({ ok: false, error: "Profile changed." });
  const question = { id: "q1", question: "Is remote work essential?" };
  const editor = (questions: Array<typeof question & { answer?: string }>, version: number) =>
    <OpenQuestionEditors questions={questions} profileVersion={version} isLatest disabled={false} />;
  await act(async () => root.render(editor([question], 1)));
  const input = container.querySelector<HTMLInputElement>('input[name="answer"]')!;
  await act(async () => typeAnswer("My draft answer"));
  await act(async () => root.render(editor([{ ...question, answer: "Other answer" }], 2)));
  expect(container.querySelector<HTMLInputElement>('input[name="answer"]')?.value).toBe("My draft answer");
  await act(async () => root.render(editor([], 3)));
  expect(container.querySelector<HTMLInputElement>('input[name="answer"]')?.value).toBe("My draft answer");
  await act(async () => submit());
  expect(vi.mocked(answerOpenQuestionSetting).mock.calls[0]![2].get("profileVersion")).toBe("1");
  expect(vi.mocked(answerOpenQuestionSetting).mock.calls[0]![2].get("answer")).toBe("My draft answer");
  expect(input.isConnected).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
  expect(container.querySelector<HTMLInputElement>('input[name="answer"]')).toBeNull();
});

it("keeps an answer typed while its earlier save is pending and shows the saved answer", async () => {
  let resolve!: (result: { ok: true; nextSnapshot: { profileVersion: string } }) => void;
  vi.mocked(answerOpenQuestionSetting).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const question = { id: "q1", question: "Is remote work essential?" };
  await act(async () => root.render(<OpenQuestionEditors questions={[question]} profileVersion={1} isLatest disabled={false} />));
  act(() => { typeAnswer("First answer"); submit(); });
  await act(async () => typeAnswer("Further answer"));
  await act(async () => resolve({ ok: true, nextSnapshot: { profileVersion: "2" } }));
  expect(container.querySelector<HTMLInputElement>('input[name="answer"]')?.value).toBe("Further answer");
  expect(container.textContent).toContain("Answered: First answer");
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
  expect(container.querySelector<HTMLInputElement>('input[name="answer"]')).toBeNull();
  expect(container.textContent).toContain("Answered: First answer");
});
