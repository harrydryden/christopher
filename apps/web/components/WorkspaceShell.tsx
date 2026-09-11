import type { ReactNode } from "react";

/** One white workspace with navy chrome, independent of route and OS theme. */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen flex-col bg-white text-slate-900">{children}</div>;
}
