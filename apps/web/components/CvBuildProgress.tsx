import { ChristopherMark } from "./brand/ChristopherMark";

const stages = [
  {
    id: "analysing",
    title: "Understand the role",
    detail:
      "Reading the company’s requirements and matching your confirmed evidence.",
  },
  {
    id: "writing",
    title: "Write your CV",
    detail:
      "Choosing relevant achievements and writing to a two-page content budget.",
  },
  {
    id: "fitting",
    title: "Fit two pages",
    detail:
      "Measuring the actual PDF and prioritising content while keeping your employment and qualifications.",
  },
  {
    id: "assessing",
    title: "Check and score",
    detail:
      "Checking the fitted wording against your evidence and the company’s job description.",
  },
];

export function CvBuildProgress({
  stage,
  queued,
}: {
  stage: string | null;
  queued: boolean;
}) {
  const index = queued ? -1 : stages.findIndex((item) => item.id === stage);
  const active = stages[index];
  return (
    <section
      aria-label="CV build progress"
      aria-busy="true"
      className="space-y-6 rounded-xl border border-slate-200 bg-slate-50 p-5 sm:p-6"
    >
      <div className="flex items-center gap-5">
        <ChristopherMark
          size={80}
          searching
          id="cv-build-wheels"
          className="shrink-0"
        />
        <div role="status" aria-live="polite" aria-atomic="true">
          <h2 className="text-lg font-semibold text-accent">
            {active?.title ??
              (queued ? "Your CV is queued" : "Preparing your CV")}
          </h2>

        </div>
      </div>
      <ol className="grid gap-3 sm:grid-cols-4" aria-label="Build stages">
        {stages.map((item, i) => (
          <li
            key={item.id}
            aria-current={i === index ? "step" : undefined}
            className={`rounded-lg border p-3 text-sm ${i === index ? "border-accent bg-white text-accent shadow-sm" : "border-slate-200 text-slate-500"}`}
          >
            <span
              className={`mb-2 inline-flex size-7 items-center justify-center rounded-full text-xs font-semibold ${i <= index ? "bg-accent text-white" : "bg-slate-200 text-slate-600"}`}
              aria-hidden="true"
            >
              {i < index ? "✓" : i + 1}
            </span>
            <p className="font-medium">{item.title}</p>
            <span className="sr-only">
              {i < index
                ? "Completed"
                : i === index
                  ? "In progress"
                  : "Waiting"}
            </span>
          </li>
        ))}
      </ol>

    </section>
  );
}
