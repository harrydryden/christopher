import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID string, validated by regex (avoids relying on zod's built-in `.uuid()` format across versions). */
export const zUuid = () => z.string().regex(UUID_RE, "invalid id");

export const zUrlString = () => z.string().trim().min(1).max(2048);

export type ActionResult = { ok: true } | { ok: false; error: string };

export function ok(): ActionResult {
  return { ok: true };
}

export function fail(error: string): ActionResult {
  return { ok: false, error };
}
