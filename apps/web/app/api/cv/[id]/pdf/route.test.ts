/** The workspace's preview and download of a saved revision: owned, ready, and throttled per account. */
import { beforeEach, expect, it, vi } from "vitest";
import { materialiseCv, type CvLibrary } from "@ava/core/cv";
const auth = vi.hoisted(() => vi.fn());
const throttle = vi.hoisted(() => vi.fn());
const draft = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ requireUser: auth }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: throttle }));
vi.mock("@/lib/queries/cv", () => ({ getOwnCvDraftForPdf: draft }));
const store = vi.hoisted(() => ({ storedCvPdf: vi.fn(), storeCvPdf: vi.fn(), cvPdfContentHash: vi.fn((content: unknown) => `hash:${JSON.stringify(content).length}`) }));
vi.mock("@/lib/cv-pdf-store", () => store);
// The assessment's own rules are tested with it; here a finalised revision is simply finalisable.
vi.mock("@ava/core/cv-review", () => ({ assertCvFinalisable: vi.fn() }));
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
  store.storedCvPdf.mockReset(); store.storedCvPdf.mockResolvedValue(null);
  store.storeCvPdf.mockReset(); store.storeCvPdf.mockResolvedValue(undefined);
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

it("serves a finalised revision's stored PDF without rendering or counting a render", async () => {
  draft.mockResolvedValue({ id: ID, status: "ready", content: CONTENT, companyName: "Acme", finalisedAt: new Date() });
  store.storedCvPdf.mockResolvedValue(Buffer.from("%PDF-kept"));
  const response = await download();
  expect(response.status).toBe(200);
  expect(store.storedCvPdf).toHaveBeenCalledWith("user-1", ID, store.cvPdfContentHash(CONTENT));
  expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-kept");
  expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(throttle).not.toHaveBeenCalled();
  expect(store.storeCvPdf).not.toHaveBeenCalled();
});

it("renders a download whose stored PDF is missing or stale, counts it, and keeps what it rendered", async () => {
  draft.mockResolvedValue({ id: ID, status: "ready", content: CONTENT, companyName: "Acme", finalisedAt: new Date() });
  const response = await download();
  expect(response.status).toBe(200);
  expect(throttle).toHaveBeenCalledWith(["cv-render:user-1"], CV_RENDER_LIMIT);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(store.storeCvPdf).toHaveBeenCalledWith("user-1", ID, store.cvPdfContentHash(CONTENT), expect.any(Buffer));
  expect(Buffer.compare(store.storeCvPdf.mock.calls[0]![3] as Buffer, bytes)).toBe(0);
});

it("always renders a preview, and never reads or writes the stored PDF for it", async () => {
  store.storedCvPdf.mockResolvedValue(Buffer.from("%PDF-kept"));
  const response = await preview();
  expect(Buffer.from(await response.arrayBuffer()).toString()).not.toBe("%PDF-kept");
  expect(store.storedCvPdf).not.toHaveBeenCalled();
  expect(store.storeCvPdf).not.toHaveBeenCalled();
});
