/**
 * The journal is what the migrator reads, and it applies an entry only when that entry's `when` is
 * later than the newest one a database already has. These cases hold the journal to that rule
 * without a database, so a migration that production would skip fails here instead of there.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertJournalOrdered, readJournal, unappliedMigrations, type JournalEntry } from "./migrate";

const folder = fileURLToPath(new URL("../drizzle", import.meta.url));
const journal = readJournal(folder);

describe("the migration journal", () => {
  it("has a strictly later `when` for every entry than for the one before it", () => {
    expect(() => assertJournalOrdered(journal)).not.toThrow();
    for (let i = 1; i < journal.length; i++) expect(journal[i]!.when).toBeGreaterThan(journal[i - 1]!.when);
  });

  it("numbers every tag by its idx, in increasing order", () => {
    for (const entry of journal) expect(entry.tag.slice(0, 5)).toBe(`${String(entry.idx).padStart(4, "0")}_`);
    for (let i = 1; i < journal.length; i++) expect(journal[i]!.idx).toBeGreaterThan(journal[i - 1]!.idx);
  });

  it("has a SQL file for every entry, and an entry for every SQL file", () => {
    for (const entry of journal) expect(existsSync(`${folder}/${entry.tag}.sql`), entry.tag).toBe(true);
    // A file with no entry is never applied anywhere, which is the same silent skip by another route.
    const files = readdirSync(folder).filter(name => name.endsWith(".sql")).map(name => name.slice(0, -4));
    expect(files.sort()).toEqual(journal.map(entry => entry.tag).sort());
  });
});

describe("assertJournalOrdered", () => {
  const entries: JournalEntry[] = [
    { idx: 33, when: 1790676000000, tag: "0033_cv_shares" },
    { idx: 34, when: 1790762400000, tag: "0034_cv_gap_quiz" },
  ];

  it("refuses an entry stamped with today's clock after a hand-dated one", () => {
    // What `drizzle-kit generate` writes on 2026-09-23: earlier than the 30 September entry above it.
    const generated = { idx: 35, when: 1790150000000, tag: "0035_generated" };
    expect(() => assertJournalOrdered([...entries, generated])).toThrow(/0035_generated.*not later than 0034_cv_gap_quiz/);
  });

  it("refuses two entries with the same `when`", () => {
    expect(() => assertJournalOrdered([...entries, { idx: 35, when: 1790762400000, tag: "0035_same_day" }])).toThrow(/not later/);
  });

  it("refuses an idx that goes backwards", () => {
    expect(() => assertJournalOrdered([...entries, { idx: 34, when: 1790848800000, tag: "0034_again" }])).toThrow(/idx 34/);
  });

  it("accepts a gap in idx, which is how parallel branches leave room for each other", () => {
    expect(() => assertJournalOrdered([...entries, { idx: 36, when: 1790935200000, tag: "0036_later" }])).not.toThrow();
  });
});

describe("unappliedMigrations", () => {
  const entries: JournalEntry[] = [
    { idx: 0, when: 1000, tag: "0000_a" },
    { idx: 1, when: 2000, tag: "0001_b" },
    { idx: 2, when: 3000, tag: "0002_c" },
  ];

  it("names the entry the migrator passed over", () => {
    // The database has a later migration than 0001_b recorded, so the migrator never ran 0001_b.
    expect(unappliedMigrations(entries, [1000, 3000])).toEqual(["0001_b"]);
  });

  it("reads created_at the way the driver returns a bigint, as text", () => {
    expect(unappliedMigrations(entries, ["1000", "2000", "3000"])).toEqual([]);
  });

  it("ignores rows the journal no longer lists, such as a newer release's migrations after a rollback", () => {
    expect(unappliedMigrations(entries, [1000, 2000, 3000, 4000])).toEqual([]);
  });
});
