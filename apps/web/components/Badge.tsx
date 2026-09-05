export type Tone = "green" | "blue" | "gray" | "amber" | "red" | "neutral";

const TONE_CLASSES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-400/30",
  blue: "bg-blue-50 text-blue-800 ring-blue-600/20 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-400/30",
  gray: "bg-gray-50 text-gray-600 ring-gray-500/20 dark:bg-gray-800 dark:text-gray-300 dark:ring-gray-400/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/30",
  red: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950 dark:text-red-300 dark:ring-red-400/30",
  neutral: "bg-slate-100 text-slate-700 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/20",
};

export function Badge({
  tone = "neutral",
  children,
  title,
  className = "",
}: {
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function jobStatusTone(status: "new" | "active" | "closed"): Tone {
  if (status === "new") return "green";
  if (status === "active") return "blue";
  return "gray";
}

export function sourceStatusTone(status: string): Tone {
  switch (status) {
    case "active":
      return "green";
    case "needs_confirmation":
      return "amber";
    case "failing":
      return "amber";
    case "blocked":
      return "red";
    case "disabled":
      return "gray";
    default:
      return "neutral";
  }
}

export function scanStatusTone(status: string): Tone {
  switch (status) {
    case "ok":
      return "green";
    case "partial":
      return "amber";
    case "suspect_empty":
      return "amber";
    case "failed":
      return "red";
    default:
      return "neutral";
  }
}

export function taskStatusTone(status: string): Tone {
  switch (status) {
    case "queued":
      return "gray";
    case "running":
      return "blue";
    case "done":
      return "green";
    case "failed":
      return "red";
    default:
      return "neutral";
  }
}

export function companyStatusTone(status: string): Tone {
  switch (status) {
    case "active":
      return "green";
    case "paused":
      return "amber";
    case "archived":
      return "gray";
    default:
      return "neutral";
  }
}

export function decisionTone(decision: "apply" | "skip"): Tone {
  return decision === "apply" ? "green" : "red";
}

export function discoveryStatusTone(status: string): Tone {
  switch (status) {
    case "resolved":
      return "green";
    case "needs_confirmation":
      return "amber";
    case "not_found":
      return "red";
    case "failed":
      return "red";
    case "running":
      return "blue";
    default:
      return "neutral";
  }
}
