/**
 * The week-over-week read on the Health page: both windows exactly seven UTC days, today included
 * in the current one, so steady traffic reads as steady rather than as growth.
 */
import { expect, it } from "vitest";
import { emptyHttpCounters, type HttpHostDailyRow } from "@ava/db";
import { dayKey, foldOutboundTraffic } from "./outbound-traffic";

const NOW = new Date("2026-09-23T15:00:00Z");
const row = (daysAgo: number, requests = 1): HttpHostDailyRow => ({
  ...emptyHttpCounters(),
  day: dayKey(NOW.getTime() - daysAgo * 86_400_000),
  host: "boards.greenhouse.io",
  via: "http",
  requests,
  bytesIn: requests * 100,
} as HttpHostDailyRow);

it("folds fifteen steady days into seven this week and seven the week before", () => {
  const rows = Array.from({ length: 15 }, (_, daysAgo) => row(daysAgo));
  const [host] = foldOutboundTraffic(rows, 7, NOW);
  expect(host).toMatchObject({ requests: 7, previousRequests: 7, bytes: 700, previousBytes: 700 });
});

it("puts today and the six days before it in the current window, and the seven before those in the previous one", () => {
  const [host] = foldOutboundTraffic([row(0, 1), row(6, 10), row(7, 100), row(13, 1000), row(14, 10_000)], 7, NOW);
  expect(host).toMatchObject({ requests: 11, previousRequests: 1100 });
});
