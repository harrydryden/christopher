// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AccountDisclosure } from "./AccountDisclosure";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps purchase destinations visible on arrival and same-page navigation", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  window.history.replaceState({}, "", "/account#top-ups");
  try {
    await act(async () => root.render(<>
      <AccountDisclosure id="top-ups" title="Top up CV credits">5 credits · £5</AccountDisclosure>
      <AccountDisclosure id="plans" title="Compare plans">Search · £29/month</AccountDisclosure>
    </>));
    const packs = host.querySelector<HTMLElement>("#top-ups")!;
    const plans = host.querySelector<HTMLElement>("#plans")!;
    expect(packs.hidden).toBe(false);
    expect(plans.hidden).toBe(false);
    expect(host.querySelector("details")).toBeNull();
    await act(async () => {
      window.history.replaceState({}, "", "/account#plans");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(plans.hidden).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState({}, "", "/");
  }
});
