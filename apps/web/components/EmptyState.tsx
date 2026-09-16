import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 border-2 border-dashed border-line-muted px-6 py-10 text-center">
      <p className="ds-pixel text-12 text-fg">{title}</p>
      {description && <p className="max-w-[440px] text-14 text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
