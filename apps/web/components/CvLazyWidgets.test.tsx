/**
 * The CV page's split widgets must not bring Suspense boundaries of their own. `next/dynamic`
 * (app router) adds one exactly when it is given a `loading` fallback (or `ssr: false`), and a
 * boundary that mounts during a navigation or a refresh shows its fallback even inside the
 * transition: the widget would flash a spinner in place and then swap in.
 */
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ loader: unknown; options: Record<string, unknown> | undefined }>);
vi.mock("next/dynamic", () => ({
  default: (loader: unknown, options?: Record<string, unknown>) => {
    calls.push({ loader, options });
    return () => null;
  },
}));

it("splits the three widgets without a fallback or a client-only render", async () => {
  await import("./CvLazyWidgets");
  expect(calls).toHaveLength(3);
  for (const { options } of calls) {
    expect(options?.loading).toBeUndefined();
    expect(options?.ssr).not.toBe(false);
  }
});
