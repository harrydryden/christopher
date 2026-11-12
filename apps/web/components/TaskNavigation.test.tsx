// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TaskNavigation } from "./TaskNavigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

const items = [
  { id: "records", label: "Records", panelId: "task-panel-records" },
  { id: "disabled", label: "Unavailable", panelId: "task-panel-disabled", disabled: true },
  { id: "import", label: "Import", panelId: "task-panel-import" },
  { id: "writing", label: "Writing", panelId: "task-panel-writing" },
] as const;

function Fixture() {
  const [active, setActive] = useState<(typeof items)[number]["id"]>("records");
  return <>
    <TaskNavigation label="Tasks" idPrefix="task" items={items} active={active} onSelect={setActive} />
    {items.map(item => <div key={item.id} id={item.panelId} role="tabpanel"
      aria-labelledby={`task-tab-${item.id}`} hidden={active !== item.id}>
      <input aria-label={`${item.label} draft`} defaultValue="" />
    </div>)}
  </>;
}

it("uses linked tabs and skips disabled tasks with Arrow, Home and End", () => {
  act(() => root.render(<Fixture />));
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const records = tabs[0]!;
  const disabled = tabs[1]!;
  const imported = tabs[2]!;
  const writing = tabs[3]!;
  expect(container.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Tasks");
  expect(records.getAttribute("aria-controls")).toBe("task-panel-records");
  expect(records.getAttribute("aria-selected")).toBe("true");
  expect(records.tabIndex).toBe(0);
  expect(disabled.disabled).toBe(true);
  expect(disabled.className).toContain("min-h-11");
  expect(container.querySelector('[role="tablist"]')?.className).toContain("flex-wrap");
  act(() => { records.focus(); records.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
  expect(document.activeElement).toBe(imported);
  expect(imported.getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector<HTMLElement>("#task-panel-import")?.hidden).toBe(false);
  act(() => imported.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(writing);
  act(() => writing.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.activeElement).toBe(records);
  act(() => records.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(document.activeElement).toBe(writing);
});

it("keeps each mounted form buffer when switching tasks", () => {
  act(() => root.render(<Fixture />));
  const imported = container.querySelector<HTMLInputElement>('input[aria-label="Import draft"]')!;
  imported.value = "A document I have not submitted";
  act(() => container.querySelector<HTMLButtonElement>("#task-tab-import")!.click());
  act(() => container.querySelector<HTMLButtonElement>("#task-tab-writing")!.click());
  expect(imported.closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(true);
  act(() => container.querySelector<HTMLButtonElement>("#task-tab-import")!.click());
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Import draft"]')).toBe(imported);
  expect(imported.value).toBe("A document I have not submitted");
});
