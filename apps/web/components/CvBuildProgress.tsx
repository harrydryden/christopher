import { Mark } from "./brand";

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
      "Choosing relevant achievements and writing to the content budget for your page limit.",
  },
  {
    id: "fitting",
    title: "Optimise",
    detail:
      "Measuring the actual PDF and prioritising the strongest content within your page limit, keeping every job and qualification.",
  },
  {
    id: "assessing",
    title: "Check and score",
    detail:
      "Checking the optimised wording against your evidence and the company’s job description.",
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
      className="space-y-6 border-2 border-line bg-raised p-5 sm:p-6"
    >
      <div className="flex items-center gap-5">
        <Mark size={64} searching className="shrink-0" />
        <div role="status" aria-live="polite" aria-atomic="true">
          <h2 className="ds-pixel text-16 text-fg">
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
            className={`border-2 p-3 text-14 ${i === index ? "border-line bg-sunken text-fg" : "border-line-muted text-muted"}`}
          >
            <span
              className={`ds-pixel mb-2 inline-flex size-6 items-center justify-center text-10 ${i <= index ? "bg-accent text-accent-fg" : "bg-track text-muted"}`}
              aria-hidden="true"> {i < index ? "✓" : i + 1}
            </span>
            <p className="font-medium">{item.title}</p>
            <span className="sr-only">
              {i < index
                ? "Completed": i === index ? "In progress": "Waiting"}
            </span>
          </li>
        ))}
      </ol>

    </section>
  );
}
