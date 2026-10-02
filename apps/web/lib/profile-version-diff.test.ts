import { expect, it } from "vitest";
import { diffLines, displayDiff, pinnedLines, questionLines, textLines } from "./profile-version-diff";

it("labels nearby additions and removals while retaining one line of context", () => {
  const diff = displayDiff(diffLines(textLines("before\nshared\nlast"), textLines("after\nshared\nlast")));
  expect(diff).toMatchObject({ added: 1, removed: 1, truncated: false });
  expect(diff.rows).toEqual([
    { kind: "removed", lines: ["before"] },
    { kind: "added", lines: ["after"] },
    { kind: "unchanged", lines: ["shared"] },
    { kind: "omitted", count: 1 },
  ]);
});

it("distinguishes pinned statement boundaries and formats question answers", () => {
  expect(pinnedLines(["one\ntwo"])).not.toEqual(pinnedLines(["one", "two"]));
  expect(questionLines([{ question: "Where?", answer: "London\nRemote" }])).toEqual([
    "Question 1: Where?", "Answer 1: London", "  Remote",
  ]);
});

it("keeps computation and displayed groups bounded for pathological short-line profiles", () => {
  const before = Array.from({ length: 25_000 }, (_, index) => `old-${index}`);
  const after = Array.from({ length: 25_000 }, (_, index) => `new-${index}`);
  const diff = displayDiff(diffLines(before, after));
  expect(diff).toMatchObject({ added: 25_000, removed: 25_000, truncated: true });
  expect(diff.rows.length).toBeLessThanOrEqual(801);
  expect(diff.rows.at(-1)).toEqual({ kind: "added", lines: ["new-24999"] });
});
