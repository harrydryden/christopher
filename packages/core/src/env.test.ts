import { expect, it } from "vitest";
import { renamedEnv } from "./env";

it("reads the new name first and the pre-rename one after it, treating empty as unset", () => {
  expect(renamedEnv({ AVA_CLI_USER: "new@example.com" }, "AVA_CLI_USER", "CHRISTOPHER_CLI_USER")).toBe("new@example.com");
  expect(renamedEnv({ CHRISTOPHER_CLI_USER: "old@example.com" }, "AVA_CLI_USER", "CHRISTOPHER_CLI_USER")).toBe("old@example.com");
  expect(renamedEnv({ AVA_DISABLE_BROWSER: "0", CHRISTOPHER_DISABLE_BROWSER: "1" }, "AVA_DISABLE_BROWSER", "CHRISTOPHER_DISABLE_BROWSER")).toBe("0");
  expect(renamedEnv({ AVA_DISABLE_BROWSER: "", CHRISTOPHER_DISABLE_BROWSER: "1" }, "AVA_DISABLE_BROWSER", "CHRISTOPHER_DISABLE_BROWSER")).toBe("1");
  expect(renamedEnv({}, "AVA_HOST_MAP", "CHRISTOPHER_HOST_MAP")).toBeUndefined();
});
