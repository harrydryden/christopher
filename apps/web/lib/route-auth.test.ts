import { expect, it } from "vitest";

import { routeUser } from "./route-auth";

it("turns a revoked or expired database session into an explicit non-cacheable 401", async () => {
  const result = await routeUser(async () => { throw new Error("Unauthorised"); });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected an authentication response");
  expect(result.response.status).toBe(401);
  expect(result.response.headers.get("cache-control")).toBe("private, no-store");
  expect(await result.response.json()).toEqual({ ok: false, error: "Please sign in again." });
});

it("does not disguise database or programming failures as authentication failures", async () => {
  await expect(routeUser(async () => { throw new Error("database unavailable"); })).rejects.toThrow("database unavailable");
});
