import { z } from "zod";

export { actionError, fail, isUserFacingError, ok, UserFacingError } from "./action-result";
export type { ActionResult } from "./action-result";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UUID string, validated by regex (avoids relying on zod's built-in `.uuid()` format across versions). */
export const zUuid = () => z.string().regex(UUID_RE, "invalid id");

export const zUrlString = () => z.string().trim().min(1).max(2048);
