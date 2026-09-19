import { describe, expect, it } from "vitest";
import { blocksToNotes, notesToBlocks, type NoteBlock } from "./notes-markdown";

const plain = (text: string) => [{ text, bold: false }];
/** What a note must survive: written, read back, written again, unchanged. */
const roundTrip = (notes: string) => blocksToNotes(notesToBlocks(notes));

describe("notesToBlocks", () => {
  it("separates paragraphs on blank lines and keeps soft breaks inside one", () => {
    expect(notesToBlocks("First line\nsecond line\n\nNew paragraph")).toEqual([
      { type: "paragraph", lines: [plain("First line"), plain("second line")] },
      { type: "paragraph", lines: [plain("New paragraph")] },
    ]);
  });

  it("reads consecutive bullet lines as one list", () => {
    expect(notesToBlocks("- one\n- two\n\nAfter")).toEqual([
      { type: "list", items: [plain("one"), plain("two")] },
      { type: "paragraph", lines: [plain("After")] },
    ]);
  });

  it("reads bold inline, including inside a bullet", () => {
    expect(notesToBlocks("- ask **Sam** first")).toEqual([
      { type: "list", items: [[{ text: "ask ", bold: false }, { text: "Sam", bold: true }, { text: " first", bold: false }]] },
    ]);
    expect(notesToBlocks("**All of it**")).toEqual([{ type: "paragraph", lines: [[{ text: "All of it", bold: true }]] }]);
  });

  it("treats an unclosed ** and a stray asterisk as the text they are", () => {
    expect(notesToBlocks("worth ** the wait")).toEqual([{ type: "paragraph", lines: [plain("worth ** the wait")] }]);
    expect(notesToBlocks("3 * 4 hires")).toEqual([{ type: "paragraph", lines: [plain("3 * 4 hires")] }]);
  });

  it("reads a legacy plain-textarea note unchanged", () => {
    const legacy = "Spoke to their recruiter in March.\nThey hire in waves.\n\n- next wave ~September\n- ask about remote";
    expect(notesToBlocks(legacy)).toEqual([
      { type: "paragraph", lines: [plain("Spoke to their recruiter in March."), plain("They hire in waves.")] },
      { type: "list", items: [plain("next wave ~September"), plain("ask about remote")] },
    ]);
    expect(roundTrip(legacy)).toBe(legacy);
  });

  it("is empty for an empty note and ignores runs of blank lines", () => {
    expect(notesToBlocks("")).toEqual([]);
    expect(notesToBlocks("\n\n \n\n")).toEqual([]);
    expect(notesToBlocks("A\n\n\n\nB")).toEqual([
      { type: "paragraph", lines: [plain("A")] },
      { type: "paragraph", lines: [plain("B")] },
    ]);
  });
});

describe("blocksToNotes", () => {
  it("writes the blank line between paragraphs back out", () => {
    const blocks: NoteBlock[] = [
      { type: "paragraph", lines: [plain("One"), plain("still one")] },
      { type: "paragraph", lines: [plain("Two")] },
    ];
    expect(blocksToNotes(blocks)).toBe("One\nstill one\n\nTwo");
    expect(notesToBlocks(blocksToNotes(blocks))) .toEqual(blocks);
  });

  it("round-trips bullets and bold, including bold inside a bullet", () => {
    for (const notes of ["- one\n- two", "- ask **Sam** first\n- then **go**", "**Bold** start, plain end", "A\n\n- b\n\nC"]) {
      expect(roundTrip(notes)).toBe(notes);
    }
  });

  it("escapes a literal ** so it never becomes bold on the way back in", () => {
    const blocks = notesToBlocks("a ** b ** c");
    expect(blocks).toEqual([{ type: "paragraph", lines: [[{ text: "a ", bold: false }, { text: " b ", bold: true }, { text: " c", bold: false }]] }]);
    // Typed as text rather than parsed, the pair is escaped and survives.
    const literal: NoteBlock[] = [{ type: "paragraph", lines: [plain("a ** b")] }];
    expect(blocksToNotes(literal)).toBe("a \\*\\* b");
    expect(notesToBlocks(blocksToNotes(literal))).toEqual(literal);
    // A lone asterisk is left alone; a backslash is escaped.
    expect(blocksToNotes([{ type: "paragraph", lines: [plain("3 * 4 and C:\\tmp")] }])).toBe("3 * 4 and C:\\\\tmp");
    expect(roundTrip("3 * 4 and C:\\\\tmp")).toBe("3 * 4 and C:\\\\tmp");
  });

  it("escapes a paragraph that begins with a bullet mark so it stays a paragraph", () => {
    const blocks: NoteBlock[] = [{ type: "paragraph", lines: [plain("- not a list")] }];
    expect(blocksToNotes(blocks)).toBe("\\- not a list");
    expect(notesToBlocks(blocksToNotes(blocks))).toEqual(blocks);
  });

  it("drops empty runs rather than writing an empty bold marker", () => {
    expect(blocksToNotes([{ type: "paragraph", lines: [[{ text: "", bold: true }, { text: "kept", bold: false }]] }])).toBe("kept");
    expect(blocksToNotes([])).toBe("");
  });
});
