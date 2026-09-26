import type { ReactNode } from "react";

/** One workspace on the white ground, independent of route and OS theme. */
export function WorkspaceShell({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen flex-col bg-bg text-fg">{children}</div>;
}
