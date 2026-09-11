import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CV_THEME } from "@christopher/core/cv";
const auth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ requireSession: auth }));
import { POST } from "./route";
beforeEach(() => { auth.mockReset(); auth.mockResolvedValue(undefined); });
const content = { name: "Example", contact: "London", summary: "Analyst", theme: DEFAULT_CV_THEME, sections: [{ entryId: "s", kind: "skill", heading: "Tools", bullets: ["Reporting"], skillItems: ["SQL"] }], gaps: [] };
it("renders an authenticated unsaved preview and reports its actual page count", async () => {
  const response = await POST(new Request("http://localhost/api/cv/preview", { method: "POST", body: JSON.stringify(content) }));
  expect(auth).toHaveBeenCalledOnce(); expect(response.status).toBe(200);
  expect(response.headers.get("x-cv-page-count")).toBe("1");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(Buffer.from(await response.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
});
it("rejects malformed and oversized bodies and unsupported themes", async () => {
  for (const body of ['bad json', JSON.stringify({ ...content, theme: { ...DEFAULT_CV_THEME, version: 99 } })]) expect((await POST(new Request('http://localhost', { method: 'POST', body }))).status).toBe(400);
  expect((await POST(new Request('http://localhost', { method: 'POST', body: 'x'.repeat(150001) }))).status).toBe(413);
});
it("requires a session before reading or rendering the content", async () => {
  auth.mockRejectedValue(new Error('Unauthorised'));
  await expect(POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify(content) }))).rejects.toThrow('Unauthorised');
});
