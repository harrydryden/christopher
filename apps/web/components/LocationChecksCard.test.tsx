import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LocationChecksCard } from "./LocationChecksCard";
import type { LocationChecks } from "@/lib/queries/location-health";
import type { WorkerStatus } from "@/lib/worker-status";

const now = new Date("2026-10-01T12:00:00.000Z");
const healthy: WorkerStatus = { state: "healthy", heartbeat: null, ageMs: null, restartsLastHour: 0, restartsLastDay: 0, heapPressure: false };
const base: LocationChecks = { total: 1, pending: 1, unavailable: 0, rows: [{
  jobId: "11111111-1111-4111-8111-111111111111", companyId: "22222222-2222-4222-8222-222222222222",
  companyName: "Example", title: "Analyst", state: "pending", revision: "rev", taskActive: true,
  taskStatus: "queued", nextAttemptAt: new Date("2026-10-01T13:00:00.000Z"),
}] };
const render = (checks: LocationChecks, worker = healthy) => renderToStaticMarkup(
  <LocationChecksCard checks={checks} worker={worker} now={now} unverified={false} />,
);

it("names a future location check and exposes its absolute time without offering a duplicate retry", () => {
  const html = render(base);
  expect(html).toContain("Waiting before checking this careers site again.");
  expect(html).toContain("Next check in 1h.");
  expect(html).toContain('dateTime="2026-10-01T13:00:00.000Z"');
  expect(html).toContain("UK time");
  expect(html).toContain("Scheduled");
  expect(html).not.toContain("Retry location check");
});

it("distinguishes a due queued read, an active read and stopped monitoring", () => {
  const due = { ...base, rows: [{ ...base.rows[0]!, nextAttemptAt: now }] };
  expect(render(due)).toContain("Location check is queued to start.");
  expect(render(due)).not.toContain("Next check in");
  const running = { ...base, rows: [{ ...base.rows[0]!, taskStatus: "running" as const }] };
  expect(render(running)).toContain("Location check is running.");
  const stopped = { ...healthy, state: "stopped" as const };
  const offline = render(base, stopped);
  expect(offline).toContain("Waiting for monitoring to resume.");
  expect(offline).not.toContain("Next check in");
});
