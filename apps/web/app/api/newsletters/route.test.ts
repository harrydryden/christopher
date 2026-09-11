import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ values: vi.fn(), rows: [] as object[], source: { id: "11111111-1111-1111-1111-111111111111", kind: "email" } as { id: string; kind: string } | undefined }));
vi.mock("@/lib/db", () => ({ db: () => ({
  select: () => ({ from: () => ({ where: async () => mocks.source ? [mocks.source] : [] }) }),
  insert: () => ({ values: (value: unknown) => { mocks.values(value); return { onConflictDoNothing: () => ({ returning: async () => mocks.rows }) }; } }),
}) }));
import { POST } from "./route";
const sourceId = "11111111-1111-1111-1111-111111111111";
function request(body: unknown, secret = "test-secret") {
  return new Request("http://localhost/api/newsletters", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
}
beforeEach(() => { vi.stubEnv("NEWSLETTER_INGEST_SECRET", "test-secret"); mocks.values.mockClear(); mocks.source = { id: sourceId, kind: "email" }; mocks.rows = [{ id: "document" }]; });
afterEach(() => vi.unstubAllEnvs());
it("rejects unauthorised requests without writing content", async () => {
  expect((await POST(request({}, "wrong"))).status).toBe(401); expect(mocks.values).not.toHaveBeenCalled();
});
it("refuses unconfigured ingestion", async () => {
  vi.stubEnv("NEWSLETTER_INGEST_SECRET", ""); expect((await POST(request({}))).status).toBe(503);
});
it("validates payloads and the source type", async () => {
  expect((await POST(request({ content: "short" }))).status).toBe(400);
  mocks.source!.kind = "website";
  expect((await POST(request({ sourceId, title: "Edition", content: "Newsletter text ".repeat(20) }))).status).toBe(404);
});
it("accepts readable text and reports redelivery as a duplicate", async () => {
  const payload = { sourceId, title: "Edition", content: "<p>Acme Robotics is expanding its team in London.</p>".repeat(5) };
  const result = await POST(request(payload));
  expect(result.status).toBe(202); expect(await result.json()).toEqual({ received: true, duplicate: false });
  expect(mocks.values.mock.calls[0]![0].content).not.toContain("<p>");
  mocks.rows = [];
  expect(await (await POST(request(payload))).json()).toEqual({ received: true, duplicate: true });
});
it("caps actual bytes even without a Content-Length header", async () => {
  expect((await POST(request({ content: "a".repeat(500001) }))).status).toBe(413);
  expect(mocks.values).not.toHaveBeenCalled();
});
