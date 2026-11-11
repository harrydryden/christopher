import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-line-faint pb-4">
      <div className="min-w-0 flex-1">
        <h1 className="min-w-0 break-words text-20 font-semibold text-fg">{title}</h1>
        {description && <p className="mt-2 min-w-0 break-words text-14 text-muted">{description}</p>}
      </div>
      {actions && <div className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
    </div>
  );
}
