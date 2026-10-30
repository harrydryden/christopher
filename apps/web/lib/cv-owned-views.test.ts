import { expect, it, vi } from "vitest";

vi.mock("@/lib/queries/cv", () => ({ getOwnCvDraft: vi.fn() }));
import { getOwnCvDraft } from "@/lib/queries/cv";
import { cvTargetingViewForOwnedDraft, getCvTargetingView } from "./cv-targeting-view";
import { cvPendingSkillViewForOwnedDraft, getCvPendingSkillView } from "./cv-pending-skills-view";

it("rejects a foreign pre-read draft before deriving either view", async () => {
  const foreign = { id: "cv-1", userId: "other", status: "ready", content: {} } as
    NonNullable<Awaited<ReturnType<typeof getOwnCvDraft>>>;
  expect(await cvTargetingViewForOwnedDraft("owner", foreign)).toBeNull();
  expect(cvPendingSkillViewForOwnedDraft("owner", foreign)).toBeNull();
  expect(getOwnCvDraft).not.toHaveBeenCalled();
});

it("keeps the account-owned wrappers to one draft read", async () => {
  vi.mocked(getOwnCvDraft).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  expect(await getCvTargetingView("owner", "cv-1")).toBeNull();
  expect(await getCvPendingSkillView("owner", "cv-1")).toBeNull();
  expect(getOwnCvDraft).toHaveBeenCalledTimes(2);
});
