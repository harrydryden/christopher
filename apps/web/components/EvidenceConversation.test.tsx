// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EvidenceConversation } from "./EvidenceConversation";
import { confirmEvidenceAnswerAsWritten, dismissEvidenceDraft, requestEvidenceDraft, skipEvidenceQuestion } from "@/app/actions/evidence";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/app/actions/evidence", () => ({
  requestEvidenceDraft: vi.fn(), retryEvidenceDraft: vi.fn(), dismissEvidenceDraft: vi.fn(),
  confirmEvidenceDraft: vi.fn(), confirmEvidenceAnswerAsWritten: vi.fn(), skipEvidenceQuestion: vi.fn(),
}));

const props = { source: "library" as const, scopeId: "person-1", question: "What result did your work produce?",
  questionId: "job:1:outcome", destination: { kind: "employment" as const, id: "job-1" },
  destinationLabel: "Operations lead at Example Company", baseVersion: 1 };

function mount(overrides: Partial<ComponentProps<typeof EvidenceConversation>> = {}) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(EvidenceConversation, { ...props, ...overrides })));
  const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name)!;
  const answer = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
  const type = async (field: HTMLTextAreaElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    await act(async () => field.dispatchEvent(new Event("input", { bubbles: true })));
  };
  return { container, root, button, answer, type };
}

afterEach(() => { vi.clearAllMocks(); window.sessionStorage.clear(); });

it("can review and save the person's answer without requesting a model draft", async () => {
  const ui = mount();
  try {
    await ui.type(ui.answer(), "I helped the team reduce handover time.");
    await act(async () => ui.button("Use my answer as written").click());
    expect(ui.container.textContent).toContain("Proposed wording");
    expect(ui.container.querySelectorAll("textarea")[1]?.value).toBe("I helped the team reduce handover time.");
    vi.mocked(confirmEvidenceAnswerAsWritten).mockResolvedValue({ ok: true, version: 2 });
    await act(async () => ui.button("Confirm and save to Operations lead at Example Company").click());
    expect(confirmEvidenceAnswerAsWritten).toHaveBeenCalledWith(expect.objectContaining({ answer: "I helped the team reduce handover time." }), "I helped the team reduce handover time.");
    expect(requestEvidenceDraft).not.toHaveBeenCalled();
    expect(ui.container.textContent).toContain("Saved to Experience.");
  } finally { act(() => ui.root.unmount()); ui.container.remove(); }
});

it("keeps the answer when returning from a proposal to edit it", async () => {
  const ui = mount();
  try {
    await ui.type(ui.answer(), "The team improved handovers.");
    vi.mocked(requestEvidenceDraft).mockResolvedValue({ ok: true, draft: { id: "draft-1", status: "drafted",
      wording: "Improved handovers.", answer: "The team improved handovers.", question: props.question,
      questionId: props.questionId, destination: props.destination, source: "library", sourceId: null,
      baseVersion: 1, error: null, attempt: 1, acceptedVersion: null } });
    await act(async () => ui.button("Review an evidence draft").click());
    vi.mocked(dismissEvidenceDraft).mockResolvedValue({ ok: true });
    await act(async () => ui.button("Edit my answer").click());
    expect(ui.answer().value).toBe("The team improved handovers.");
    expect(ui.container.textContent).not.toContain("Nothing further for this question.");
  } finally { act(() => ui.root.unmount()); ui.container.remove(); }
});

it("persists Nothing further without losing a rough answer", async () => {
  const ui = mount();
  try {
    await ui.type(ui.answer(), "A rough answer to revisit");
    vi.mocked(skipEvidenceQuestion).mockResolvedValue({ ok: true });
    await act(async () => ui.button("Nothing further").click());
    expect(skipEvidenceQuestion).toHaveBeenCalledWith(expect.objectContaining({ questionId: props.questionId, baseVersion: 1 }));
    expect(ui.container.textContent).toContain("Nothing further for this question.");
    await act(async () => ui.button("Return to this question").click());
    expect(ui.answer().value).toBe("A rough answer to revisit");
  } finally { act(() => ui.root.unmount()); ui.container.remove(); }
});

it("restores an unfinished answer after the conversation remounts", async () => {
  const first = mount();
  await first.type(first.answer(), "A fact I am still checking");
  act(() => first.root.unmount()); first.container.remove();
  const returned = mount();
  try { expect(returned.answer().value).toBe("A fact I am still checking"); }
  finally { act(() => returned.root.unmount()); returned.container.remove(); }
});

it("a late draft poll cannot replace an explicit choice to use the original answer", async () => {
  let finish!: (value: unknown) => void;
  const response = new Promise(resolve => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(() => response));
  const initialDraft = { id: "draft-2", status: "queued" as const, wording: null, error: null,
    attempt: 1, acceptedVersion: null, question: props.question, questionId: props.questionId,
    answer: "We supported the change.", destination: props.destination, baseVersion: 1,
    source: "library" as const, sourceId: null };
  const ui = mount({ initialDraft });
  try {
    await act(async () => ui.button("Use my answer as written").click());
    await act(async () => finish({ ok: true, json: async () => ({ status: "drafted", wording: "Changed the whole operation.", error: null, attempt: 1 }) }));
    expect(ui.container.querySelectorAll("textarea")[1]?.value).toBe("We supported the change.");
  } finally { act(() => ui.root.unmount()); ui.container.remove(); vi.unstubAllGlobals(); }
});

it("restores edited wording and a CV question's explicit confirmation after navigation", async () => {
  const confirmed = vi.fn();
  const quiz = { source: "cv_quiz" as const, sourceId: "cv-1", onConfirmed: confirmed };
  const first = mount(quiz);
  await first.type(first.answer(), "We worked on the handover process.");
  await act(async () => first.button("Use my answer as written").click());
  await first.type(first.container.querySelectorAll<HTMLTextAreaElement>("textarea")[1]!, "Supported handover changes with the team.");
  act(() => first.root.unmount()); first.container.remove();
  const review = mount(quiz);
  expect(review.container.querySelectorAll<HTMLTextAreaElement>("textarea")[1]?.value).toBe("Supported handover changes with the team.");
  expect([...review.container.querySelectorAll("button")].map(item => item.textContent)).toContain("Confirm for Operations lead at Example Company");
  await act(async () => review.button("Confirm for Operations lead at Example Company").click());
  act(() => review.root.unmount()); review.container.remove();
  confirmed.mockClear();
  const returned = mount(quiz);
  try {
    expect(returned.container.textContent).toContain("Wording confirmed for this CV question.");
    expect(confirmed).toHaveBeenCalledWith("Supported handover changes with the team.");
  } finally { act(() => returned.root.unmount()); returned.container.remove(); }
});
