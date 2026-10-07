// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { AccountDisclosure } from "./AccountDisclosure";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("opens the requested purchase section on arrival and same-page navigation", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  window.history.replaceState({}, "", "/account#top-ups");
  try {
    await act(async () => root.render(<>
      <AccountDisclosure id="top-ups" title="Top up CV credits">5 credits · £5</AccountDisclosure>
      <AccountDisclosure id="plans" title="Compare plans">Search · £29/month</AccountDisclosure>
    </>));
    const packs = host.querySelector<HTMLDetailsElement>("#top-ups")!;
    const plans = host.querySelector<HTMLDetailsElement>("#plans")!;
    expect(packs.open).toBe(true);
    expect(plans.open).toBe(false);
    await act(async () => {
      window.history.replaceState({}, "", "/account#plans");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(plans.open).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState({}, "", "/");
  }
});
