export type Tone = "green" | "blue" | "gray" | "amber" | "red" | "neutral";

/** Tones map to the status roles in docs/DESIGN-SYSTEM.md, not to raw hues.
    There are no tinted fills in this system: a badge is an outline and text in
    one colour, so it reads the same on every surface. */
const TONE_CLASSES: Record<Tone, string> = {
  green: "border-ok text-ok",
  blue: "border-info text-info",
  // `gray` predates `neutral`; both are the muted step on the one neutral ramp.
  gray: "border-muted text-muted",
  amber: "border-warn text-warn",
  red: "border-danger text-danger",
  neutral: "border-fg text-fg",
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
      className={`ds-pixel inline-flex items-center gap-1 border px-1.5 py-0.5 text-9 tracking-badge whitespace-nowrap ${TONE_CLASSES[tone]} ${className}`}
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
