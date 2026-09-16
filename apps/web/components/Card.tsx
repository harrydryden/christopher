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
    <section className={`border-2 border-line bg-raised ${raised ? "shadow-hard-3" : ""} ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-line px-4 py-2.5">
          {title && <h2 className="ds-pixel text-12 text-fg">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
