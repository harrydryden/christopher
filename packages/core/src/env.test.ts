import { expect, it } from "vitest";
import { renamedEnv } from "./env";

it("reads the new name first, then the AVA name, then the Christopher one, treating empty as unset", () => {
  const names = ["COL_CLI_USER", "AVA_CLI_USER", "CHRISTOPHER_CLI_USER"] as const;
  expect(renamedEnv({ COL_CLI_USER: "new@example.com", AVA_CLI_USER: "ava@example.com", CHRISTOPHER_CLI_USER: "old@example.com" }, ...names)).toBe("new@example.com");
  expect(renamedEnv({ AVA_CLI_USER: "ava@example.com", CHRISTOPHER_CLI_USER: "old@example.com" }, ...names)).toBe("ava@example.com");
  expect(renamedEnv({ CHRISTOPHER_CLI_USER: "old@example.com" }, ...names)).toBe("old@example.com");
  expect(renamedEnv({ COL_DISABLE_BROWSER: "0", AVA_DISABLE_BROWSER: "1", CHRISTOPHER_DISABLE_BROWSER: "1" }, "COL_DISABLE_BROWSER", "AVA_DISABLE_BROWSER", "CHRISTOPHER_DISABLE_BROWSER")).toBe("0");
  expect(renamedEnv({ COL_DISABLE_BROWSER: "", AVA_DISABLE_BROWSER: "1" }, "COL_DISABLE_BROWSER", "AVA_DISABLE_BROWSER", "CHRISTOPHER_DISABLE_BROWSER")).toBe("1");
  expect(renamedEnv({ COL_DISABLE_BROWSER: "", AVA_DISABLE_BROWSER: "", CHRISTOPHER_DISABLE_BROWSER: "1" }, "COL_DISABLE_BROWSER", "AVA_DISABLE_BROWSER", "CHRISTOPHER_DISABLE_BROWSER")).toBe("1");
  expect(renamedEnv({}, "COL_HOST_MAP", "AVA_HOST_MAP", "CHRISTOPHER_HOST_MAP")).toBeUndefined();
});

it("reads only the AVA name after the new one for a variable that never had a Christopher name", () => {
  expect(renamedEnv({ AVA_EVAL_GATE_REQUIRE_VERIFIED: "1" }, "COL_EVAL_GATE_REQUIRE_VERIFIED", "AVA_EVAL_GATE_REQUIRE_VERIFIED")).toBe("1");
  expect(renamedEnv({ CHRISTOPHER_EVAL_GATE_REQUIRE_VERIFIED: "1" }, "COL_EVAL_GATE_REQUIRE_VERIFIED", "AVA_EVAL_GATE_REQUIRE_VERIFIED")).toBeUndefined();
});
