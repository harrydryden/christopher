import type { ReactNode } from "react";

export function Card({
  title,
  actions,
  children,
  raised = false,
  className = "",
  bodyClassName = "p-4",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Lift the card off the page with the 8px hard shadow. Login uses it. */
  raised?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`bg-raised ${raised ? "border-2 border-line shadow-hard-3" : "border border-line-faint"} ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-faint px-4 py-3">
          {title && <h2 className="text-16 font-semibold text-fg">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
