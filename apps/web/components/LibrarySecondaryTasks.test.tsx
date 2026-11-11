// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LibrarySecondaryTasks } from "./LibrarySecondaryTasks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("shows the first import task and retains unsent fields across task changes", () => {
  act(() => root.render(<LibrarySecondaryTasks initialTask="import" records={<input aria-label="Career detail" defaultValue="Draft role" />}
    importForm={<input aria-label="Imported text" defaultValue="" />}
    writingForm={<input aria-label="Writing style" defaultValue="" />} />));
  const imported = container.querySelector<HTMLInputElement>('input[aria-label="Imported text"]')!;
  act(() => { imported.value = "A draft I have not submitted"; imported.dispatchEvent(new Event("input", { bubbles: true })); });
  const writing = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Writing preferences")!;
  act(() => writing.click());
  expect(imported.closest("div[hidden]")).not.toBeNull();
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Import a document")!.click());
  expect(imported.value).toBe("A draft I have not submitted");
  expect(imported.closest("div[hidden]")).toBeNull();
  // Active tasks remain open; these are destinations, never toggle disclosures.
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Import a document")!.click());
  expect(imported.closest("div[hidden]")).toBeNull();
  act(() => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Your records")!.click());
  expect(imported.closest("div[hidden]")).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Career detail"]')!.closest("div[hidden]")).toBeNull();
  expect(container.innerHTML).not.toContain("<details");
});
