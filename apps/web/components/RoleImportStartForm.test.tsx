// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/app/actions/role-import", () => ({ startRoleImport: vi.fn(async () => ({ ok: true })) }));
import { RoleImportStartForm } from "./RoleImportStartForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<RoleImportStartForm />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("keeps a typed link when switching to PDF and back", () => {
  const link = container.querySelector<HTMLInputElement>('input[name="url"]')!;
  const pdf = container.querySelector<HTMLInputElement>('input[name="file"]')!;
  act(() => {
    link.value = "https://example.org/jobs/operations";
    link.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const radios = container.querySelectorAll<HTMLInputElement>('input[name="kind"]');
  act(() => radios[1]!.click());
  expect(pdf.disabled).toBe(false);
  expect(link.disabled).toBe(true);
  act(() => radios[0]!.click());
  expect(link.value).toBe("https://example.org/jobs/operations");
  expect(link.disabled).toBe(false);
  expect(pdf.disabled).toBe(true);
});
