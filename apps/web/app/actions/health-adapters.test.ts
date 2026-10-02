import { beforeEach, expect, it, vi } from "vitest";
import { UserFacingError, zUuid } from "@/lib/validation";

const companyActions = vi.hoisted(() => ({ markSourceConfirmed: vi.fn(), useDiscoveryCandidate: vi.fn() }));
const helpers = vi.hoisted(() => ({ revalidate: vi.fn(), refuseOn: vi.fn() }));
const auth = vi.hoisted(() => ({ requireUser: vi.fn(), requireVerifiedUser: vi.fn(), requireAdmin: vi.fn() }));
const database = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("./companies", () => companyActions);
vi.mock("@/lib/action-helpers", () => helpers);
vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/db", () => database);

import { confirmHealthSource, keepHealthCurrentSource, useHealthCandidate } from "./health";

beforeEach(() => {
  companyActions.markSourceConfirmed.mockReset();
  companyActions.useDiscoveryCandidate.mockReset();
  helpers.revalidate.mockReset();
  auth.requireUser.mockReset();
  database.db.mockReset();
});

it("shows a member's stale source-confirmation refusal beside the Health form", async () => {
  companyActions.markSourceConfirmed.mockRejectedValue(new UserFacingError("Only an administrator can replace this source now."));
  expect(await confirmHealthSource("source-id", { ok: true }, new FormData())).toEqual({
    ok: false, error: "Only an administrator can replace this source now.",
  });
  expect(companyActions.markSourceConfirmed).toHaveBeenCalledWith("source-id");
});

it("shows a candidate reactivation refusal after source state changes", async () => {
  companyActions.useDiscoveryCandidate.mockRejectedValue(new UserFacingError("Only an administrator can turn this source back on."));
  expect(await useHealthCandidate("run-id", 2, { ok: true }, new FormData())).toEqual({
    ok: false, error: "Only an administrator can turn this source back on.",
  });
  expect(companyActions.useDiscoveryCandidate).toHaveBeenCalledWith("run-id", 2);
});

it("refreshes Health after a confirmed source or candidate choice", async () => {
  companyActions.markSourceConfirmed.mockResolvedValue(undefined);
  companyActions.useDiscoveryCandidate.mockResolvedValue(undefined);
  expect(await confirmHealthSource("source-id", { ok: true }, new FormData())).toEqual({ ok: true });
  expect(await useHealthCandidate("run-id", 0, { ok: true }, new FormData())).toEqual({ ok: true });
  expect(helpers.revalidate).toHaveBeenNthCalledWith(1, "/health");
  expect(helpers.revalidate).toHaveBeenNthCalledWith(2, "/health");
});

it("lets an uncertain failure reach the form instead of claiming a definite refusal", async () => {
  const uncertain = new Error("Connection lost after the request started");
  companyActions.useDiscoveryCandidate.mockRejectedValue(uncertain);
  await expect(useHealthCandidate("run-id", 0, { ok: true }, new FormData())).rejects.toBe(uncertain);
  expect(helpers.revalidate).not.toHaveBeenCalled();
});

it("refreshes Health after keeping the current source", async () => {
  const companyId = "00000000-0000-4000-8000-000000000001";
  const runId = "00000000-0000-4000-8000-000000000002";
  expect(zUuid().safeParse(runId).success).toBe(true);
  auth.requireUser.mockResolvedValue({ id: "account-id" });
  const tx = { select: () => ({ from: () => ({ where: () => ({
    for: async () => [{ companyId, status: "resolved" }],
    limit: async () => [{ status: "active" }],
  }) }) }) };
  database.db.mockReturnValue({ transaction: async (run: (writer: typeof tx) => Promise<unknown>) => run(tx) });

  expect(await keepHealthCurrentSource(runId, { ok: true }, new FormData())).toEqual({ ok: true });
  expect(helpers.revalidate).toHaveBeenNthCalledWith(1, "/health", "/companies", `/companies/${companyId}`);
  expect(helpers.revalidate).toHaveBeenNthCalledWith(2, "/health");
});

it("leaves an unexpected keep-current failure uncertain for SettingsForm", async () => {
  const uncertain = new Error("Connection lost after the request started");
  auth.requireUser.mockRejectedValue(uncertain);
  await expect(keepHealthCurrentSource("00000000-0000-4000-8000-000000000002", { ok: true }, new FormData())).rejects.toBe(uncertain);
  expect(helpers.revalidate).not.toHaveBeenCalled();
});
