// @vitest-environment jsdom
/**
 * How much of the roles table renders per keystroke, per `j`/`k` press and per reason-box edit.
 *
 * Each row's title cell is wrapped in a React `<Profiler>` (through the table primitives the row
 * renders with), so every commit that renders a row reports that row's id. A row that bailed out
 * of rendering reports nothing. Typing in one row's reason box must render no other row, and moving
 * the cursor must render only the two rows whose highlight changed — on a 50-row page, where
 * rendering all of them per key is what made typing lag on a phone.
 */
import { act, Profiler, type ReactNode, type TdHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RoleCompaniesVM, RoleRowVM } from "@/lib/queries/jobs";

const rendered = vi.hoisted(() => [] as string[]);
vi.mock("@/components/table", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/table")>();
  function TD(props: TdHTMLAttributes<HTMLTableCellElement>) {
    const cell = <actual.TD {...props} />;
    return props.id?.startsWith("role-row-")
      ? <Profiler id={props.id.slice("role-row-".length)} onRender={(id) => { rendered.push(id); }}>{cell}</Profiler>
      : cell;
  }
  return { ...actual, TD };
});
const parsed = vi.hoisted(() => ({ runs: 0 }));
vi.mock("@/lib/notes-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes-markdown")>();
  return { ...actual, parseRuns: (...args: Parameters<typeof actual.parseRuns>) => { parsed.runs++; return actual.parseRuns(...args); } };
});
const actions = vi.hoisted(() => ({ decide: vi.fn(), decideRoles: vi.fn(), decideWithUndoToken: vi.fn(), decideRolesWithUndoTokens: vi.fn(), undoDecisionIfCurrent: vi.fn(), undoDecisionsIfCurrent: vi.fn(), archiveRoles: vi.fn(), roleDetails: vi.fn() }));
vi.mock("@/app/actions/decisions", () => actions);
vi.mock("@/app/actions/cv", () => ({ requestCv: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { RolesTable } from "./RolesTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function role(n: number): RoleRowVM {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id, companyId: `company-${n % 5}`, companyName: `Company ${n % 5}`, title: `Role ${n}`,
    url: `https://example.test/jobs/${n}`, location: "Manchester", locations: ["Manchester"], remote: false,
    department: null, employmentType: null, salaryText: null, status: "active", workflowStatus: "auto-matched",
    stage: "matched", applicationStatus: null, liveForText: "3 days", liveForBasis: "posted", seeded: false,
    fitScore: 50 + (n % 40), scoreState: "scored", scoreStateText: null, fitVerdict: "possible", fitRationale: "Operations in Manchester.",
    keywordTerms: ["operations"], addedByYou: false, manual: false, decision: null,
  };
}
const ROWS = Array.from({ length: 50 }, (_, n) => role(n));
const COMPANIES: RoleCompaniesVM = Object.fromEntries(Array.from({ length: 5 }, (_, n) => [`company-${n}`, { iconSrc: null, domain: `c${n}.test`, homepageUrl: `https://c${n}.test` }]));

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
  actions.decideWithUndoToken.mockImplementation((jobId: string, decision: string, reason: string) => actions.decide(jobId, decision, reason));
  actions.roleDetails.mockReturnValue(new Promise(() => undefined));
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<RolesTable rows={ROWS} companies={COMPANIES} keyboard emptyState={<p>Nothing</p>} />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function press(key: string, target: EventTarget = document.body) {
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
}
function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** The rows that rendered while `run` ran. */
function rowsRenderedBy(run: () => void): string[] {
  rendered.length = 0;
  run();
  return [...rendered];
}

it("renders every row once on mount, so the probe sees them", () => {
  expect(new Set(rowsRenderedBy(() => act(() => root.render(<RolesTable key="again" rows={ROWS} companies={COMPANIES} keyboard emptyState={<p>Nothing</p>} />)))).size).toBe(50);
});

it("reads a narrow card from role identity through context to action and selection", () => {
  const cells = [...container.querySelectorAll<HTMLTableCellElement>("tbody tr:first-child > td")];
  expect(cells.map(cell => cell.className)).toEqual([
    expect.stringContaining("roleTitle"), expect.stringContaining("roleCompany"),
    expect.stringContaining("roleLocation"), expect.stringContaining("roleFit"),
    expect.stringContaining("roleAction"), expect.stringContaining("roleSelect"),
  ]);
  expect(cells[2]?.textContent).toContain("Location:");
  expect(cells[2]?.textContent).toContain("Matched: operations");
  expect(cells[3]?.textContent).toContain("Fit:");
});

it("renders only the two rows whose highlight moved on each j and k", () => {
  expect(rowsRenderedBy(() => press("j")).sort()).toEqual([ROWS[0]!.id, ROWS[1]!.id].sort());
  expect(rowsRenderedBy(() => press("j")).sort()).toEqual([ROWS[1]!.id, ROWS[2]!.id].sort());
  expect(rowsRenderedBy(() => press("k")).sort()).toEqual([ROWS[1]!.id, ROWS[2]!.id].sort());
  // At the top already: nothing moves, nothing renders.
  press("k");
  expect(rowsRenderedBy(() => press("k"))).toEqual([]);
});

it("renders at most the row being typed in on each keystroke in its reason box", () => {
  press("j");
  press("s");
  const box = container.querySelector<HTMLTextAreaElement>("tbody textarea")!;
  expect(box).not.toBeNull();
  let text = "";
  for (const letter of "Too junior") {
    text += letter;
    const during = rowsRenderedBy(() => type(box, text));
    expect(during.filter(id => id !== ROWS[1]!.id)).toEqual([]);
    expect(during.length).toBeLessThanOrEqual(1);
  }
  expect(box.value).toBe("Too junior");
  // The text the box owns is what is saved.
  actions.decide.mockReturnValue(new Promise(() => undefined));
  press("Enter", box);
  expect(actions.decide).toHaveBeenCalledWith(ROWS[1]!.id, "skip", "Too junior");
});

it("does not parse an open description again when the row around it renders", async () => {
  actions.roleDetails.mockResolvedValue({
    ok: true,
    details: {
      jobId: ROWS[0]!.id, description: "## The role\n- Run **twelve** sites\n- Lead four managers", salaryText: null, department: null, employmentType: null,
      keywordTerms: [], fitVerdict: null, fitRationale: null, locationReason: "Your filter names no location, so every location passes.",
      cvQuote: null, cvBlocked: null, archiveNotes: [],
    },
  });
  await act(async () => { press("s"); await Promise.resolve(); });
  expect(container.querySelector(`#role-review-${ROWS[0]!.id} strong`)?.textContent).toBe("twelve");
  const before = parsed.runs;
  // Switching the box from Dismiss to Shortlist renders the row, not its description.
  const shortlist = [...container.querySelectorAll<HTMLButtonElement>(`#role-review-${ROWS[0]!.id} button`)].find(b => b.textContent === "Shortlist")!;
  expect(rowsRenderedBy(() => act(() => shortlist.click()))).toEqual([ROWS[0]!.id]);
  expect(shortlist.getAttribute("aria-pressed")).toBe("true");
  expect(parsed.runs).toBe(before);
});

it("renders only the rows whose selection changed when x toggles one", () => {
  expect(rowsRenderedBy(() => press("x"))).toEqual([ROWS[0]!.id]);
});
