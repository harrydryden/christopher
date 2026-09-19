/**
 * The Versions card: the history as a list, and a comparison as a plain list of what moved.
 *
 * Restoring is deliberately absent. A saved version is immutable and the only way back to older
 * wording is to type it and save again, which appends a version like any other edit — so the card
 * reads the history and never rewrites it.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { CvLibrary, Employment } from "@christopher/core/cv";
import { diffCvLibraries } from "./cv-library-diff";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const { LibraryVersions } = await import("../components/LibraryVersions");

const acme: Employment = { id: "acme", company: "Acme", jobTitle: "Operations Director", startDate: "2023-01", endDate: "", current: true };
const library = (details: string): CvLibrary => ({
  name: "Test Candidate", contact: "London", profile: "Operations", structuredExperience: true,
  employment: [acme],
  entries: [{ id: "acme-block", kind: "experience", status: "active", heading: "Acme", employmentId: "acme", details }],
});

const now = new Date("2026-09-19T12:00:00Z");
const versions = [
  { version: 3, createdAt: new Date("2026-09-19T09:00:00Z") },
  { version: 2, createdAt: new Date("2026-09-17T09:00:00Z") },
  { version: 1, createdAt: new Date("2026-09-01T09:00:00Z") },
];

it("lists every saved version newest first and marks the one being edited", () => {
  const html = renderToStaticMarkup(createElement(LibraryVersions, { versions, current: 3, diff: null, now }));
  expect(html).toContain("Versions");
  expect(html).toContain("Version 3");
  expect(html).toContain("Version 1");
  expect(html).toContain("1 Sep");
  expect(html).toContain("Current");
  expect(html).toContain("Compare");
  // A history is read, never rewritten: nothing here restores an old version over a new one.
  expect(html).not.toContain("Restore");
});

it("renders a comparison as a plain list of what was added, removed and reworded", () => {
  const diff = diffCvLibraries(library("Led a team\nRan the rota"), library("Led a team of nine\nShipped the new rota in March"), 1, 3);
  const html = renderToStaticMarkup(createElement(LibraryVersions, { versions, current: 3, diff, now }));
  expect(html).toContain("Version 1 to version 3 · 2 rows reworded");
  expect(html).toContain("Operations Director · Acme · Jan 2023 – Present");
  expect(html).toContain("Reworded · Led a team → Led a team of nine");
  expect(html).toContain("Reworded · Ran the rota → Shipped the new rota in March");
});

it("says so when there is nothing saved yet", () => {
  const html = renderToStaticMarkup(createElement(LibraryVersions, { versions: [], current: 0, diff: null, now }));
  expect(html).toContain("Nothing saved yet. Your first save becomes version 1.");
  expect(html).not.toContain("Compare");
});
