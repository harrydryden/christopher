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
      className="block text-xs font-medium text-accent underline underline-offset-2"
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
          <div
            role="tablist"
            aria-label="CV builder"
            className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1"
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
                className={`shrink-0 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 ${selected === tab ? "bg-accent text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
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
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-accent hover:bg-slate-50"
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
            className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 lg:sticky lg:top-6"
          >
            <h2
              id="cv-job-description-title"
              className="border-b border-slate-200 px-5 py-4 font-semibold text-accent"
            >
              Job description
            </h2>
            <div className="max-h-[70vh] space-y-4 overflow-y-auto break-words p-5 text-sm leading-relaxed lg:max-h-[calc(100vh-10rem)]">
              {description}
            </div>
          </aside>
        </div>
      </div>
    </TabContext.Provider>
  );
}
