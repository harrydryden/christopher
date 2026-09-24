/**
 * What an action's catch-all turns an error into. A refusal from a gate, or a redirect a gate
 * asked for, must leave the action as itself: swallowing either told a signed-out person that a
 * save "could not be made" when the truth was that they had to sign in again.
 */
import { describe, expect, it, vi } from "vitest";
import { actionError, UserFacingError } from "./validation";

/** What `redirect()` throws: an error the router recognises by its digest. */
function redirectSignal(to: string) {
  return Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` });
}

describe("actionError", () => {
  it("lets a gate's refusal and a gate's redirect through, as themselves", () => {
    expect(() => actionError(new Error("Unauthorised"), "Could not save.")).toThrow("Unauthorised");
    expect(() => actionError(new Error("Forbidden"), "Could not save.")).toThrow("Forbidden");
    expect(() => actionError(redirectSignal("/account?verify=required"), "Could not save.")).toThrow("NEXT_REDIRECT");
    expect(() => actionError(Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }), "Could not save.")).toThrow("NEXT_NOT_FOUND");
  });

  it("shows a person their own refusal, and the fallback for anything else", () => {
    expect(actionError(new UserFacingError("Save your Library first."), "Could not save.")).toEqual({ ok: false, error: "Save your Library first." });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(actionError(new Error("relation \"cv_drafts\" does not exist"), "Could not save.")).toEqual({ ok: false, error: "Could not save." });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).not.toContain("cv_drafts");
    error.mockRestore();
  });
});
