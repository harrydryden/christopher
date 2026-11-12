import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), ack: vi.fn(), db: {} }));
vi.mock("@/lib/route-auth", () => ({ routeUser: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: () => mocks.db }));
vi.mock("@col/db", () => ({ getCvActivities: mocks.read, acknowledgeCvActivity: mocks.ack }));
import { GET, POST } from "./route";
const id = "12345678-1234-4234-8234-123456789abc";
const request = (origin = "https://example.com", value = id) => new Request("https://example.com/api/cv/activity", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ id: value }) });
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ok: true, user: { id: "owner" } }); mocks.read.mockResolvedValue([]); mocks.ack.mockResolvedValue(true); });
it("authenticates both operations before accessing account data", async () => {
  mocks.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
  expect((await GET()).status).toBe(401); expect((await POST(request())).status).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.ack).not.toHaveBeenCalled();
});
it("returns private, uncached account readings", async () => {
  const response = await GET(); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.read).toHaveBeenCalledWith(mocks.db, "owner");
});
it("rejects cross-origin and invalid IDs, and acknowledges for the authenticated owner only", async () => {
  expect((await POST(request("https://attacker.test"))).status).toBe(403);
  expect((await POST(request("https://example.com", "bad"))).status).toBe(400); expect(mocks.ack).not.toHaveBeenCalled();
  expect((await POST(request())).status).toBe(200); expect(mocks.ack).toHaveBeenCalledWith(mocks.db, "owner", id);
  mocks.ack.mockResolvedValue(false); expect((await POST(request())).status).toBe(404);
});
