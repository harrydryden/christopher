/** The workspace's preview and download of a saved revision: owned, ready, and throttled per account. */
import { beforeEach, expect, it, vi } from "vitest";
import { materialiseCv, type CvLibrary } from "@col/core/cv";
const auth = vi.hoisted(() => vi.fn());
const throttle = vi.hoisted(() => vi.fn());
const draft = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ requireUser: auth }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: throttle }));
vi.mock("@/lib/queries/cv", () => ({ getOwnCvDraftForPdf: draft }));
const store = vi.hoisted(() => ({ storedFinalisedCvPdf: vi.fn() }));
vi.mock("@/lib/cv-pdf-store", () => store);
import { GET } from "./route";
import { CV_RENDER_BUSY_SENTENCE, CV_RENDER_LIMIT } from "@/lib/cv-render-limit";

const ID = "00000000-0000-4000-8000-000000000001";
const LIBRARY: CvLibrary = {
  name: "Example", contact: "London", profile: "Analyst",
  entries: [{ id: "job", kind: "experience", heading: "Director · Acme", details: "Led a team", confirmedResponsibilities: ["Led a team"] }],
};
const CONTENT = materialiseCv(LIBRARY, { summary: "Analyst", sections: [{ entryId: "job", bullets: ["Led a team"] }], gaps: [] });
const preview = () => GET(new Request(`http://localhost/api/cv/${ID}/pdf?preview=1`), { params: Promise.resolve({ id: ID }) });
const download = () => GET(new Request(`http://localhost/api/cv/${ID}/pdf`), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  auth.mockReset(); auth.mockResolvedValue({ id: "user-1" });
  throttle.mockReset(); throttle.mockResolvedValue(true);
  draft.mockReset(); draft.mockResolvedValue({ id: ID, status: "ready", content: CONTENT, companyName: "Acme", finalisedAt: null });
  store.storedFinalisedCvPdf.mockReset(); store.storedFinalisedCvPdf.mockResolvedValue(null);
});

it("renders a saved revision's preview for its owner and counts it against the account", async () => {
  const response = await preview();
  expect(response.status).toBe(200);
  expect(draft).toHaveBeenCalledWith("user-1", ID);
  expect(throttle).toHaveBeenCalledWith(["cv-render:user-1"], CV_RENDER_LIMIT);
  expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
});

it("refuses a render past the account's limit, and never counts a request that renders nothing", async () => {
  throttle.mockResolvedValue(false);
  const refused = await preview();
  expect(refused.status).toBe(429);
  expect(await refused.text()).toBe(CV_RENDER_BUSY_SENTENCE);

  throttle.mockClear();
  draft.mockResolvedValue(null);
  expect((await preview()).status).toBe(404);
  expect(throttle).not.toHaveBeenCalled();
});

it("serves a finalised revision's immutable PDF even when its old assessment is no longer current", async () => {
  draft.mockResolvedValue({ id: ID, status: "ready", content: CONTENT, companyName: "Acme", finalisedAt: new Date(), assessment: { version: "old" } });
  store.storedFinalisedCvPdf.mockResolvedValue(Buffer.from("%PDF-kept"));
  const response = await download();
  expect(response.status).toBe(200);
  expect(store.storedFinalisedCvPdf).toHaveBeenCalledWith("user-1", ID);
  expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-kept");
  expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(throttle).not.toHaveBeenCalled();
});

it("previews the same approved bytes as download for a finalised historical revision", async () => {
  draft.mockResolvedValue({ id: ID, status: "ready", content: { obsoleteSchema: true }, companyName: "Acme", finalisedAt: new Date(), assessment: { version: "old" } });
  store.storedFinalisedCvPdf.mockResolvedValue(Buffer.from("%PDF-approved"));
  const response = await preview();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
  expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-approved");
  expect(throttle).not.toHaveBeenCalled();
});

it("does not download an unfinished revision even if an artefact row exists", async () => {
  store.storedFinalisedCvPdf.mockResolvedValue(Buffer.from("%PDF-kept"));
  const response = await download();
  expect(response.status).toBe(409);
  expect(store.storedFinalisedCvPdf).not.toHaveBeenCalled();
});

it("refuses to reconstruct a missing final PDF because a fresh render might differ", async () => {
  draft.mockResolvedValue({ id: ID, status: "ready", content: CONTENT, companyName: "Acme", finalisedAt: new Date() });
  const response = await download();
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("Create a new revision");
  expect(throttle).not.toHaveBeenCalled();
  expect((await preview()).status).toBe(409);
  expect(throttle).not.toHaveBeenCalled();
});

it("always renders a preview without reading the final PDF", async () => {
  store.storedFinalisedCvPdf.mockResolvedValue(Buffer.from("%PDF-kept"));
  const response = await preview();
  expect(Buffer.from(await response.arrayBuffer()).toString()).not.toBe("%PDF-kept");
  expect(store.storedFinalisedCvPdf).not.toHaveBeenCalled();
});
