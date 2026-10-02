import { beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

const queries = vi.hoisted(() => ({ getPreferenceProfile: vi.fn(), listProfileVersions: vi.fn(), getCalibration: vi.fn(), listPendingFilterSuggestionsResolved: vi.fn(), getReasonTagEditor: vi.fn() }));
vi.mock("@/lib/queries/learning", () => queries);
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "account-a" }), needsEmailConfirmation: () => false }));
vi.mock("@/lib/settings", () => ({ getSettings: async () => ({ seedProfile: "Starting preferences" }) }));
vi.mock("@/app/actions/learning", () => Object.fromEntries(["acceptFilterSuggestionSetting", "rejectFilterSuggestionSetting", "rescoreAllRolesSetting", "resynthesizeNowSetting", "savePinnedStatementsSetting", "saveSeedProfileSetting", "savePreferenceProfileSetting", "acceptReasonTagSetting", "suggestFromScansNowSetting"].map(name => [name, vi.fn()])));
vi.mock("@/app/actions/decisions", () => ({ saveDecisionTagsSetting: vi.fn() }));
import LearningPage from "./page";
import { ProfileComparison } from "@/components/ProfileComparison";
import { LearningProfileEditor } from "@/components/LearningProfileEditor";
import { ReasonTagList } from "@/components/ReasonTagList";

function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as React.ReactElement<{ children?: ReactNode }>;
  return [{ type: element.type, props: element.props }, ...elements(element.props.children)];
}
const profile = (version: number) => ({ version, markdown: `Profile ${version}`, pinnedStatements: [], openQuestions: [], generatedAt: new Date(), sourceDecisionCount: 1 });
beforeEach(() => {
  vi.clearAllMocks();
  queries.listProfileVersions.mockResolvedValue([{ version: 3 }, { version: 1 }]);
  queries.getPreferenceProfile.mockImplementation(async (_user: string, version?: number) => version === undefined || version === 3 ? profile(3) : version === 1 ? profile(1) : null);
  queries.getCalibration.mockResolvedValue({ totalDecisions: 1, neededForCalibration: 19 });
  queries.listPendingFilterSuggestionsResolved.mockResolvedValue([]);
  queries.getReasonTagEditor.mockResolvedValue({ vocabulary: [], recent: [], page: 2, totalPages: 2, totalDecisions: 26 });
});
it("compares the previous owned version across numbering gaps and keeps current editors", async () => {
  const tree = elements(await LearningPage({ searchParams: Promise.resolve({ tagsPage: "2" }) }));
  expect(queries.getPreferenceProfile.mock.calls).toEqual([["account-a", undefined], ["account-a", 1]]);
  expect(tree.find(node => node.type === ProfileComparison)?.props).toMatchObject({ previous: { version: 1 }, current: { version: 3 } });
  expect(tree.filter(node => node.type === LearningProfileEditor)).toHaveLength(2);
  expect(tree.find(node => node.type === ReasonTagList)?.props).toMatchObject({ page: 2, totalPages: 2, totalDecisions: 26 });
  expect(queries.getReasonTagEditor).toHaveBeenCalledWith("account-a", "2");
});
it.each(["", "0", "-1", "1.5", "3e0", "999999999999999999999999", ["1", "3"]].map(v => ({ v })))("rejects malformed version $v before any profile query", async ({ v }) => {
  const tree = elements(await LearningPage({ searchParams: Promise.resolve({ v }) }));
  expect(queries.getPreferenceProfile).not.toHaveBeenCalled();
  expect(tree.some(node => node.type === ProfileComparison || node.type === LearningProfileEditor)).toBe(false);
  expect(tree.some(node => node.type === "p" && node.props.children === "This saved profile version is not available.")).toBe(true);
});
it("does not compare a missing version or fall back to another account", async () => {
  const tree = elements(await LearningPage({ searchParams: Promise.resolve({ v: "2" }) }));
  expect(queries.getPreferenceProfile.mock.calls).toEqual([["account-a", 2]]);
  expect(tree.some(node => node.type === ProfileComparison || node.type === LearningProfileEditor)).toBe(false);
});
it("does not offer comparison without an earlier version", async () => {
  const tree = elements(await LearningPage({ searchParams: Promise.resolve({ v: "1" }) }));
  expect(queries.getPreferenceProfile.mock.calls).toEqual([["account-a", 1]]);
  expect(tree.some(node => node.type === ProfileComparison)).toBe(false);
  expect(tree.find(node => node.type === ReasonTagList)?.props.profileVersionParam).toBe("1");
});

it("opens saved history separately so current drafts remain mounted", async () => {
  const tree = elements(await LearningPage({ searchParams: Promise.resolve({}) }));
  const card = tree.find(node => node.props.title === "Preference profile");
  const form = elements(card?.props.actions as ReactNode).find(node => node.type === "form");
  expect(form?.props).toMatchObject({ method: "get", action: "/learning", target: "_blank", rel: "noopener" });
});
