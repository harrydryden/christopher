// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CvWorkspace, CvWorkspacePanel } from "./CvWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalScroll = HTMLElement.prototype.scrollIntoView;
HTMLElement.prototype.scrollIntoView = vi.fn();
afterEach(() => {
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
