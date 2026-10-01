import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProfileComparison, type ComparedProfile } from "./ProfileComparison";

const profile = (version: number, overrides: Partial<ComparedProfile> = {}): ComparedProfile => ({
  version, markdown: "# Preferences\nRemote work", pinnedStatements: ["Keep London"],
  openQuestions: [{ id: "q-one", question: "Where?", answer: "London" }], ...overrides,
});
const render = (previous: ComparedProfile, current: ComparedProfile) => renderToStaticMarkup(<ProfileComparison previous={previous} current={current} />);

it("offers a native read-only comparison with labelled, escaped added and removed lines", () => {
  const html = render(profile(1), profile(2, {
    markdown: "# Preferences\n<script>alert(1)</script>", pinnedStatements: ["Keep remote"],
    openQuestions: [{ id: "q-one", question: "Where?", answer: "Remote" }],
  }));
  expect(html).toContain("<details");
  expect(html).toContain("Compare with previous version");
  expect(html).toContain("Changes from version 1 to version 2");
  expect(html).toContain("Profile text changes");
  expect(html).toContain("Pinned statements changes");
  expect(html).toContain("Open questions and answers changes");
  expect(html).toContain("Added");
  expect(html).toContain("Removed");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});

it("states when stored content is unchanged, but identifies a replaced question record", () => {
  const same = render(profile(1), profile(2));
  expect(same).toContain("No changes to stored profile text, pinned statements or questions.");
  const replaced = render(profile(1), profile(2, { openQuestions: [{ id: "q-two", question: "Where?", answer: "London" }] }));
  expect(replaced).toContain("A question record changed");
  expect(replaced).toContain("No wording or answer changes in this section.");
  expect(replaced).not.toContain("No changes to stored profile text, pinned statements or questions.");
});

it("shows grouping changes and keeps full versions available when the diff is abbreviated", () => {
  const grouping = render(profile(1, { pinnedStatements: ["one\ntwo"] }), profile(2, { pinnedStatements: ["one", "two"] }));
  expect(grouping).toContain("Statement 2: two");
  const before = Array.from({ length: 1_000 }, (_, index) => `old-${index}`).join("\n");
  const after = Array.from({ length: 1_000 }, (_, index) => `new-${index}`).join("\n");
  const html = render(profile(1, { markdown: before }), profile(2, { markdown: after }));
  expect(html).toContain("Read full profile text in both versions");
  expect(html).toContain("old-500");
  expect(html).toContain("new-500");
});
