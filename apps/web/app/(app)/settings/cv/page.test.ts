import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement } from "react";

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const appearance = vi.hoisted(() => ({ getDefaultCvAppearance: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/cv-appearance", () => appearance);
vi.mock("@/app/actions/cv", () => ({ saveCvAppearance: vi.fn() }));
import CvAppearanceSettingsPage from "./page";
import { DefaultCvAppearance } from "@/components/DefaultCvAppearance";

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireUser.mockResolvedValue({ id: "owner-a" });
  appearance.getDefaultCvAppearance.mockResolvedValue({ primary: "#123456" });
});

it("loads only the signed-in owner's appearance for its named settings task", async () => {
  const page = await CvAppearanceSettingsPage();
  expect(auth.requireUser).toHaveBeenCalledOnce();
  expect(appearance.getDefaultCvAppearance).toHaveBeenCalledWith("owner-a");
  const children = (page.props as { children: unknown[] }).children;
  expect(children.some(child => isValidElement(child) && child.type === DefaultCvAppearance)).toBe(true);
});

it("does not read an appearance when authentication fails", async () => {
  auth.requireUser.mockRejectedValue(new Error("unauthorised"));
  await expect(CvAppearanceSettingsPage()).rejects.toThrow("unauthorised");
  expect(appearance.getDefaultCvAppearance).not.toHaveBeenCalled();
});
