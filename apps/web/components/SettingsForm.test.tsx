// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/validation";
import { SettingsForm } from "./SettingsForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function field(name: string) {
  return container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

function edit(name: string, value: string) {
  const input = field(name);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit() {
  container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
}

function render(action: (_previous: ActionResult, data: FormData) => Promise<ActionResult>) {
  return act(async () => root.render(
    <SettingsForm action={action} successMessage="Saved.">
      <input name="keyword" defaultValue="" />
      <input name="location" defaultValue="London" />
    </SettingsForm>,
  ));
}

it("retains every edit and shows validation errors inline", async () => {
  const action = vi.fn(async () => ({ ok: false, error: "Enter at least one keyword." } as ActionResult));
  await render(action);
  await act(async () => {
    edit("location", "Edinburgh");
    submit();
  });
  expect(action).toHaveBeenCalledOnce();
  expect(field("location").value).toBe("Edinburgh");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter at least one keyword.");
  expect(container.querySelector('[role="alert"] a')).toBeNull();
});

it("keeps a conflicting draft and offers its exact recovery page in a new tab", async () => {
  await render(async () => ({ ok: false, error: "The profile changed.", recovery: { href: "/learning", label: "Check the latest profile in a new tab" } }));
  await act(async () => { edit("location", "Edinburgh"); submit(); });
  expect(field("location").value).toBe("Edinburgh");
  const check = container.querySelector<HTMLAnchorElement>('[role="alert"] a')!;
  expect(check.textContent).toBe("Check the latest profile in a new tab");
  expect(check.getAttribute("href")).toBe("/learning");
  expect(check.target).toBe("_blank");
  expect(check.className).toContain("min-h-11");
});

it("keeps the form usable when a save's response is lost", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await render(async () => { throw new TypeError("Failed to fetch"); });
  await act(async () => {
    edit("location", "Edinburgh");
    submit();
  });
  expect(field("location").value).toBe("Edinburgh");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't confirm whether this went through");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("here. Check");
  const check = container.querySelector<HTMLAnchorElement>('[role="alert"] a')!;
  expect(check.textContent).toBe("Check saved work in a new tab before trying again.");
  expect(check.className).toContain("min-h-11");
  expect(check.getAttribute("href")).toBe("");
  expect(check.target).toBe("_blank");
  expect(check.rel).toBe("noopener noreferrer");
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

it("does not reset edits made while a confirmed save is pending", async () => {
  let resolve!: (result: ActionResult) => void;
  const action = vi.fn(() => new Promise<ActionResult>(done => { resolve = done; }));
  await render(action);
  act(() => { edit("keyword", "Analyst"); submit(); });
  await act(async () => edit("location", "Edinburgh"));
  await act(async () => resolve({ ok: true }));
  expect(field("keyword").value).toBe("Analyst");
  expect(field("location").value).toBe("Edinburgh");
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("tracks edits on controls associated with the form from elsewhere in the page", async () => {
  let resolve!: (result: ActionResult) => void;
  const action = vi.fn(() => new Promise<ActionResult>(done => { resolve = done; }));
  await act(async () => root.render(<>
    <SettingsForm id="shared" action={action} successMessage="Saved.">
      <input name="keyword" defaultValue="" />
    </SettingsForm>
    <textarea name="summary" form="shared" defaultValue="Original" />
  </>));
  act(() => submit());
  const summary = container.querySelector<HTMLTextAreaElement>('textarea[name="summary"]')!;
  await act(async () => {
    summary.value = "Edited while saving";
    summary.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => resolve({ ok: true }));
  expect(summary.value).toBe("Edited while saving");
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it("keeps an external submitter's intent and ignores another click while pending", async () => {
  let resolve!: (result: ActionResult) => void;
  const action = vi.fn((_previous: ActionResult, _data: FormData) => new Promise<ActionResult>(done => { resolve = done; }));
  await act(async () => root.render(<>
    <SettingsForm id="draft" action={action}><input name="summary" defaultValue="Ready" /></SettingsForm>
    <button type="submit" form="draft" name="intent" value="improve">Rebuild</button>
  </>));
  const rebuild = container.querySelector<HTMLButtonElement>('button[form="draft"]')!;
  act(() => { rebuild.click(); rebuild.click(); });
  expect(action).toHaveBeenCalledOnce();
  expect(action.mock.calls[0]![1].get("intent")).toBe("improve");
  await act(async () => resolve({ ok: true }));
});

it("resets unchanged fields after a confirmed save", async () => {
  await render(async () => ({ ok: true }));
  await act(async () => { edit("keyword", "Analyst"); submit(); });
  expect(field("keyword").value).toBe("");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Saved.");
});

it("lets Next navigation signals reach the router", async () => {
  const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/account;307;" });
  await render(async () => { throw redirect; });
  await expect(act(async () => submit())).rejects.toBe(redirect);
});
