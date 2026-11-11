"use client";

import { useState, type ReactNode } from "react";

/** Keep unsent import and writing fields mounted while changing Experience tasks. */
export function LibrarySecondaryTasks({ initialTask = "records", records, importForm, writingForm }: {
  initialTask?: "records" | "import" | "writing";
  records: ReactNode;
  importForm: ReactNode;
  writingForm: ReactNode;
}) {
  const [task, setTask] = useState<"records" | "import" | "writing">(initialTask);
  return <section aria-label="Experience workspace" className="space-y-3 border-t border-line-muted pt-3">
    <nav className="flex flex-wrap gap-2" aria-label="Experience tasks">
      <button type="button" className="min-h-11 border border-line-muted px-3 text-14" aria-current={task === "records" ? "page" : undefined}
        onClick={() => setTask("records")}>Your records</button>
      <button type="button" className="min-h-11 border border-line-muted px-3 text-14" aria-current={task === "import" ? "page" : undefined}
        onClick={() => setTask("import")}>Import a document</button>
      <button type="button" className="min-h-11 border border-line-muted px-3 text-14" aria-current={task === "writing" ? "page" : undefined}
        onClick={() => setTask("writing")}>Writing preferences</button>
    </nav>
    <div hidden={task !== "records"}>{records}</div>
    <div id="library-import-panel" hidden={task !== "import"}>{importForm}</div>
    <div hidden={task !== "writing"}>{writingForm}</div>
  </section>;
}
