"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { manageCvs } from "@/app/actions/cv";
import { Button } from "./Button";

type Row = {
  id: string;
  company: string;
  jobTitle: string;
  status: string;
  revision: number;
  createdAt: Date;
};

export function CvSavedTable({
  rows,
  archived = false,
}: {
  rows: Row[];
  archived?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const selectedIds = selected.filter((id) =>
    rows.some((row) => row.id === id),
  );
  const all = rows.length > 0 && selectedIds.length === rows.length;
  const action = archived ? "restore" : "archive";
  const label = archived ? "Restore" : "Archive";
  const run = (operation: "archive" | "restore" | "delete", ids: string[]) => {
    if (
      operation === "delete" &&
      !confirm(
        `Permanently delete ${ids.length === 1 ? "this CV" : `these ${ids.length} CVs`}? Saved application PDFs will be kept.`,
      )
    )
      return;
    setError("");
    startTransition(async () => {
      const form = new FormData();
      ids.forEach((id) => form.append("cvId", id));
      form.set("action", operation);
      try {
        const result = await manageCvs({ ok: true }, form);
        if (result.ok) setSelected([]);
        else setError(result.error);
      } catch {
        setError("Could not update these CVs. Please try again.");
      }
    });
  };
  if (!rows.length)
    return (
      <p className="text-sm text-slate-500">
        No {archived ? "archived" : "saved"} CVs.
      </p>
    );
  return (
    <fieldset
      disabled={pending}
      className="min-w-0 space-y-3"
      aria-busy={pending}
    >
      <legend className="sr-only">
        {archived ? "Archived" : "Saved"} CV actions
      </legend>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-sm text-slate-500" role="status">
          {pending ? "Updating CVs…" : `${selectedIds.length} selected`}
        </span>
        <Button
          size="sm"
          disabled={!selectedIds.length || pending}
          onClick={() => run(action, selectedIds)}
        >
          {label} selected
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={!selectedIds.length || pending}
          onClick={() => run("delete", selectedIds)}
        >
          Delete selected
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            {archived ? "Archived" : "Saved"} CVs
          </caption>
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="w-10 p-3">
                <input
                  type="checkbox"
                  aria-label={`Select all ${archived ? "archived" : "saved"} CVs on this page`}
                  checked={all}
                  ref={(element) => {
                    if (element)
                      element.indeterminate = selectedIds.length > 0 && !all;
                  }}
                  onChange={() =>
                    setSelected(all ? [] : rows.map((row) => row.id))
                  }
                />
              </th>
              <th scope="col" className="p-3">
                Company
              </th>
              <th scope="col" className="p-3">
                Job role
              </th>
              <th scope="col" className="whitespace-nowrap p-3">
                Date / version
              </th>
              <th scope="col" className="p-3">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.map((row) => (
              <tr
                key={row.id}
                className={selectedIds.includes(row.id) ? "bg-slate-50" : ""}
              >
                <td className="p-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.company} · ${row.jobTitle} · version ${row.revision}`}
                    checked={selectedIds.includes(row.id)}
                    onChange={() =>
                      setSelected(
                        selectedIds.includes(row.id)
                          ? selectedIds.filter((id) => id !== row.id)
                          : [...selectedIds, row.id],
                      )
                    }
                  />
                </td>
                <td className="p-3 align-top font-medium">{row.company}</td>
                <td className="p-3 align-top">
                  <Link className="underline" href={`/cv/${row.id}`}>
                    {row.jobTitle}
                  </Link>
                  <span className="mt-1 block text-xs capitalize text-slate-500">
                    {archived ? `Archived · ${row.status}` : row.status}
                  </span>
                </td>
                <td className="whitespace-nowrap p-3 align-top">
                  <time dateTime={new Date(row.createdAt).toISOString()}>
                    {new Date(row.createdAt).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      timeZone: "UTC",
                    })}
                  </time>
                  <span className="mt-1 block text-xs text-slate-500">
                    Version {row.revision}
                  </span>
                </td>
                <td className="p-3 align-top">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => run(action, [row.id])}>
                      {label}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => run("delete", [row.id])}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </fieldset>
  );
}
