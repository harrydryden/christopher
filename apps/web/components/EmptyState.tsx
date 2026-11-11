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
    <div className="flex min-w-0 flex-col items-center gap-2 border-2 border-dashed border-line-muted px-4 py-8 text-center sm:px-6 sm:py-10">
      <h2 className="max-w-full min-w-0 break-words text-16 font-semibold text-fg">{title}</h2>
      {description && <p className="max-w-[440px] min-w-0 break-words text-14 text-muted">{description}</p>}
      {action && <div className="mt-2 flex max-w-full min-w-0 flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
