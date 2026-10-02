// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CvWorkspace, CvWorkspacePanel } from "./CvWorkspace";
import { CvNextAction } from "./CvNextAction";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalScroll = HTMLElement.prototype.scrollIntoView;
HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", window.location.pathname);
});

it("opens the tab named by a next-action hash link", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<>
      <a href="#cv-panel-evaluation">Open Evaluation</a>
      <CvWorkspace description={<p>Advert</p>}>
        <CvWorkspacePanel tab="content"><p>Content text</p></CvWorkspacePanel>
        <CvWorkspacePanel tab="evaluation"><p>Evaluation text</p></CvWorkspacePanel>
      </CvWorkspace>
    </>));
    expect(container.querySelector('#cv-panel-evaluation')?.hasAttribute("hidden")).toBe(true);
    await act(async () => {
      window.history.pushState(null, "", "#cv-panel-evaluation");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector('#cv-panel-evaluation')?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector('#cv-panel-content')?.hasAttribute("hidden")).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
    HTMLElement.prototype.scrollIntoView = originalScroll;
  }
});

it("reopens review from an unchanged fragment and restores Evaluation when revalidation drops it", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/cv/review-test");
  const container = document.createElement("div");
  document.body.append(container);
  const view = () => <>
    <CvNextAction id="review-test" next={{ title: "Review the flagged items", detail: "Review each item.", target: "review", action: "Review flagged items" }} />
    <CvWorkspace description={<p>Advert</p>}>
      <CvWorkspacePanel tab="content"><p>Content text</p></CvWorkspacePanel>
      <CvWorkspacePanel tab="evaluation"><div id="cv-guided-review" tabIndex={-1}>Nothing further to add · saved</div></CvWorkspacePanel>
    </CvWorkspace>
  </>;
  let root = createRoot(container);
  try {
    await act(async () => root.render(view()));
    await act(async () => {
      window.history.pushState(null, "", "#cv-guided-review");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector('#cv-panel-evaluation')?.hasAttribute("hidden")).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>('#cv-tab-content')!.click());
    expect(container.querySelector('#cv-panel-evaluation')?.hasAttribute("hidden")).toBe(true);
    await act(async () => container.querySelector<HTMLAnchorElement>('a[href="#cv-guided-review"]')!.click());
    expect(container.querySelector('#cv-panel-evaluation')?.hasAttribute("hidden")).toBe(false);

    await act(async () => root.unmount());
    window.history.replaceState(null, "", "/cv/review-test");
    root = createRoot(container);
    await act(async () => root.render(view()));
    expect(container.querySelector('#cv-panel-evaluation')?.hasAttribute("hidden")).toBe(false);
    expect(container.textContent).toContain("Nothing further to add · saved");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    HTMLElement.prototype.scrollIntoView = originalScroll;
  }
});
