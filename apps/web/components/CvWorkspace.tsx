"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const tabs = [
  ["content", "Content"],
  ["evaluation", "Evaluation"],
  ["appearance", "Appearance and settings"],
] as const;
type CvTab = (typeof tabs)[number][0];
const TabContext = createContext<{
  selected: CvTab;
  openContent?: (id: string) => void;
}>({ selected: "content" });

export function CvContentBlockLink({
  id = "cv-panel-content",
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  const { openContent } = useContext(TabContext);
  return (
    <a
      href={`#${encodeURIComponent(id)}`}
      onClick={(event) => {
        if (
          !openContent ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        )
          return;
        event.preventDefault();
        window.history.pushState(null, "", `#${encodeURIComponent(id)}`);
        openContent(id);
      }}
      className="block text-12 font-medium text-fg underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/** Hidden panels remain mounted so edits, previews and review controls survive navigation. */
export function CvWorkspacePanel({
  tab,
  children,
}: {
  tab: CvTab;
  children: ReactNode;
}) {
  const { selected } = useContext(TabContext);
  return (
    <div
      role="tabpanel"
      id={`cv-panel-${tab}`}
      aria-labelledby={`cv-tab-${tab}`}
      hidden={selected !== tab}
      tabIndex={0}
      className="min-w-0 space-y-4"
    >
      {children}
    </div>
  );
}

export function CvWorkspace({
  children,
  description,
}: {
  children: ReactNode;
  description: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<CvTab>("content");
  const [focusRequest, setFocusRequest] = useState<{ id: string }>();
  function openContent(id: string) {
    setSelected("content");
    setFocusRequest({ id });
  }
  useEffect(() => {
    function followFragment() {
      let id: string;
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        return;
      }
      if (id === "cv-panel-content" || id.startsWith("cv-content-"))
        openContent(id);
    }
    followFragment();
    window.addEventListener("hashchange", followFragment);
    window.addEventListener("popstate", followFragment);
    return () => {
      window.removeEventListener("hashchange", followFragment);
      window.removeEventListener("popstate", followFragment);
    };
  }, []);
  useEffect(() => {
    if (!focusRequest || selected !== "content") return;
    const target = document.getElementById(focusRequest.id);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center", behavior: "instant" });
    setFocusRequest(undefined);
  }, [focusRequest, selected]);
  return (
    <TabContext.Provider value={{ selected, openContent }}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-muted pb-3">
          <div
            role="tablist"
            aria-label="CV builder"
            className="flex max-w-full gap-1 overflow-x-auto bg-sunken p-1"
          >
            {tabs.map(([tab, label], index) => (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`cv-tab-${tab}`}
                aria-controls={`cv-panel-${tab}`}
                aria-selected={selected === tab}
                tabIndex={selected === tab ? 0 : -1}
                onClick={() => setSelected(tab)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : event.key === "ArrowRight"
                          ? (index + 1) % tabs.length
                          : event.key === "ArrowLeft"
                            ? (index + tabs.length - 1) % tabs.length
                            : null;
                  if (next === null) return;
                  event.preventDefault();
                  setSelected(tabs[next]![0]);
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
                className={`ds-pixel shrink-0 border-2 px-3 py-2 text-11 ${selected === tab ? "border-accent bg-accent text-accent-fg" : "border-transparent text-muted hover:bg-sunken"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="cv-job-description"
            onClick={() => setOpen((value) => !value)}
            className="border border-line-muted px-3 py-2 text-14 font-medium text-fg hover:bg-sunken"
          >
            {open ? "Hide job description" : "Show job description"}
          </button>
        </div>
        <div
          className={`grid items-start gap-5 ${open ? "lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.35fr)]" : "grid-cols-1"}`}
        >
          <div data-cv-main className="min-w-0 space-y-4">
            {children}
          </div>
          <aside
            id="cv-job-description"
            hidden={!open}
            aria-labelledby="cv-job-description-title"
            className="min-w-0 border border-line-muted bg-sunken lg:sticky lg:top-6"
          >
            <h2
              id="cv-job-description-title"
              className="border-b border-line-muted px-5 py-4 font-semibold text-fg"
            >
              Job description
            </h2>
            <div className="max-h-[70vh] space-y-4 overflow-y-auto break-words p-5 text-14 leading-relaxed lg:max-h-[calc(100vh-10rem)]">
              {description}
            </div>
          </aside>
        </div>
      </div>
    </TabContext.Provider>
  );
}
