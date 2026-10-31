import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CV_THEME } from "@col/core/cv";
import PDFDocument from "pdfkit";
const auth = vi.hoisted(() => vi.fn());
const throttle = vi.hoisted(() => vi.fn());
const ownDraft = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ requireUser: auth }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: throttle }));
vi.mock("@/lib/queries/cv", () => ({ getOwnCvDraftForPdf: ownDraft }));
import { POST } from "./route";
import { CV_RENDER_BUSY_SENTENCE, CV_RENDER_LIMIT } from "@/lib/cv-render-limit";
beforeEach(() => { auth.mockReset(); auth.mockResolvedValue({ id: "user-1" }); throttle.mockReset(); throttle.mockResolvedValue(true); ownDraft.mockReset(); });
const content = { name: "Example", contact: "London", summary: "Analyst", theme: DEFAULT_CV_THEME, sections: [{ entryId: "s", kind: "skill", heading: "Tools", bullets: ["Reporting"], skillItems: ["SQL"] }], gaps: [] };
it("renders an authenticated unsaved preview and reports its actual page count", async () => {
  const response = await POST(new Request("http://localhost/api/cv/preview", { method: "POST", body: JSON.stringify(content) }));
  expect(auth).toHaveBeenCalledOnce(); expect(response.status).toBe(200);
  expect(response.headers.get("x-cv-page-count")).toBe("1");
  expect(response.headers.get("x-cv-summary-lines")).toBe("1");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
});
it("hydrates the company-first heading from the account-owned draft snapshot", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  ownDraft.mockResolvedValue({ librarySnapshot: { name: "Example", contact: "", profile: "",
    employment: [{ id: "job", company: "Acme", jobTitle: "Manager", startDate: "2020", endDate: "2024", current: false,
      industryDescriptions: "Healthcare, Software" }],
    entries: [{ id: "role", kind: "experience", heading: "Manager", details: "Led delivery", employmentId: "job" }] } });
  const draw = vi.spyOn(PDFDocument.prototype, "text");
  const cv = { ...content, sections: [{ entryId: "role", kind: "experience", heading: "Manager · Acme · 2020 – 2024",
    bullets: ["Led delivery"] }] };
  const response = await POST(new Request("http://localhost/api/cv/preview", { method: "POST",
    body: JSON.stringify({ draftId: id, content: cv }) }));
  expect(response.status).toBe(200);
  expect(ownDraft).toHaveBeenCalledWith("user-1", id);
  expect(draw.mock.calls.some(call => call[0] === "Acme · Manager · 2020 - 2024")).toBe(true);
  draw.mockRestore();
  ownDraft.mockResolvedValue(null);
  expect((await POST(new Request("http://localhost/api/cv/preview", { method: "POST",
    body: JSON.stringify({ draftId: id, content: cv }) }))).status).toBe(404);
});
it("rejects malformed and oversized bodies and unsupported themes", async () => {
  for (const body of ['bad json', JSON.stringify({ ...content, theme: { ...DEFAULT_CV_THEME, version: 99 } })]) expect((await POST(new Request('http://localhost', { method: 'POST', body }))).status).toBe(400);
  expect((await POST(new Request('http://localhost', { method: 'POST', body: 'x'.repeat(150001) }))).status).toBe(413);
});
it("requires a session before reading or rendering the content", async () => {
  auth.mockRejectedValue(new Error('Unauthorised'));
  const response = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(content) }));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ ok: false, error: "Please sign in again." });
});
it("counts each render against the account, and refuses one past the limit without rendering it", async () => {
  await POST(new Request("http://localhost/api/cv/preview", { method: "POST", body: JSON.stringify(content) }));
  expect(throttle).toHaveBeenCalledWith(["cv-render:user-1"], CV_RENDER_LIMIT);
  expect(CV_RENDER_LIMIT).toEqual({ max: 30, windowMs: 15 * 60 * 1000 });
  throttle.mockResolvedValue(false);
  const response = await POST(new Request("http://localhost/api/cv/preview", { method: "POST", body: JSON.stringify(content) }));
  expect(response.status).toBe(429);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(await response.text()).toBe(CV_RENDER_BUSY_SENTENCE);
});
