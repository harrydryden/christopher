"use client";

import { useState, type ReactNode } from "react";
import { TaskNavigation } from "./TaskNavigation";

/** Keep unsent import and writing fields mounted while changing Experience tasks. */
export function LibrarySecondaryTasks({ initialTask = "records", records, importForm, writingForm }: {
  initialTask?: "records" | "import" | "writing";
  records: ReactNode;
  importForm: ReactNode;
  writingForm: ReactNode;
}) {
  const [task, setTask] = useState<"records" | "import" | "writing">(initialTask);
  const tasks = [
    { id: "records", label: "Your records", panelId: "library-records-panel" },
    { id: "import", label: "Import a document", panelId: "library-import-panel" },
    { id: "writing", label: "Writing preferences", panelId: "library-writing-panel" },
  ] as const;
  return <section aria-label="Experience workspace" className="space-y-3 border-t border-line-muted pt-3">
    <TaskNavigation label="Experience tasks" idPrefix="library-task" items={tasks} active={task} onSelect={setTask} />
    <div id="library-records-panel" role="tabpanel" aria-labelledby="library-task-tab-records" hidden={task !== "records"}>{records}</div>
    <div id="library-import-panel" role="tabpanel" aria-labelledby="library-task-tab-import" hidden={task !== "import"}>{importForm}</div>
    <div id="library-writing-panel" role="tabpanel" aria-labelledby="library-task-tab-writing" hidden={task !== "writing"}>{writingForm}</div>
  </section>;
}
