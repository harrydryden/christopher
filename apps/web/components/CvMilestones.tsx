const STEPS = ["Evidence", "Role", "Generate", "Review & download"] as const;

type CvMilestone = "evidence" | "role" | "generate" | "review";

const STEP_INDEX: Record<CvMilestone, number> = {
  evidence: 0,
  role: 1,
  generate: 2,
  review: 3,
};

export function CvMilestones({ current, failed = false }: { current: CvMilestone; failed?: boolean }) {
  const currentIndex = STEP_INDEX[current];

  return <nav aria-label="CV building progress" className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-4 sm:px-5">
    <ol className="flex items-start">
      {STEPS.map((label, index) => {
        const complete = index < currentIndex;
        const active = index === currentIndex;
        const circle = active && failed
          ? "border-red-600 bg-red-600 text-white"
          : complete || active
            ? "border-[var(--app-navy)] bg-[var(--app-navy)] text-white"
            : "border-slate-300 bg-white text-slate-400";
        const text = active ? failed ? "font-medium text-red-700" : "font-medium text-slate-900" : complete ? "text-slate-600" : "text-slate-400";

        return <li key={label} className="min-w-0 flex-1" aria-current={active ? "step" : undefined}>
          <div className="flex items-center">
            <span aria-hidden="true" className={`h-px flex-1 ${index > 0 && index <= currentIndex ? "bg-[var(--app-navy)]" : "bg-slate-300"} ${index === 0 ? "invisible" : ""}`} />
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${circle}`} aria-hidden="true">
              {complete ? "✓" : index + 1}
            </span>
            <span aria-hidden="true" className={`h-px flex-1 ${index < currentIndex ? "bg-[var(--app-navy)]" : "bg-slate-300"} ${index === STEPS.length - 1 ? "invisible" : ""}`} />
          </div>
          <span className={`mt-2 block px-1 text-center text-[0.7rem] leading-tight sm:text-xs ${text}`}>
            {label}{active && failed ? <span className="block">Failed</span> : null}
          </span>
        </li>;
      })}
    </ol>
  </nav>;
}
