"use client";

import Link from "next/link";
import { cvVersionLabel } from "@/lib/cv-version";
import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ActionResult } from "@/lib/validation";
import { Pagination } from "./Pagination";
import { isCvPage, type CvPages, type CvRow } from "@/lib/cv-table-data";
import { Button } from "./Button";

type Operation = "archive" | "restore" | "delete";
const ManagementContext = createContext<{
  pending: boolean;
  pages?: CvPages;
  run: (
    operation: Operation,
    ids: string[],
    done: (result: ActionResult) => void,
  ) => void;
} | null>(null);

/** Both tables receive the committed server snapshot through one bounded JSON request. */
export function CvManagement({
  children,
  savedPage,
  archivedPage,
}: {
  children: ReactNode;
  savedPage: number;
  archivedPage: number;
}) {
  const [pending, setPending] = useState(false);
  const [pages, setPages] = useState<CvPages>();
  const inFlight = useRef(false);
  function run(
    operation: Operation,
    ids: string[],
    done: (result: ActionResult) => void,
  ) {
    if (inFlight.current || !ids.length) return;
    if (
      operation === "delete" &&
      !confirm(
        `Permanently delete ${ids.length === 1 ? "this CV" : `these ${ids.length} CVs`}? Saved application PDFs will be kept.`,
      )
    )
      return;
    inFlight.current = true;
    setPending(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    void (async () => {
      try {
        const response = await fetch("/api/cv/manage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: operation,
            ids,
            savedPage,
            archivedPage,
          }),
          signal: controller.signal,
        });
        const result = (await response.json()) as {
          ok?: boolean;
          pages?: { saved?: unknown; archived?: unknown };
          error?: unknown;
        };
        const saved = result.pages?.saved,
          archived = result.pages?.archived;
        if (
          response.ok &&
          result.ok === true &&
          isCvPage(saved) &&
          isCvPage(archived)
        ) {
          setPages({ saved, archived });
          done({ ok: true });
        } else
          done({
            ok: false,
            error:
              typeof result.error === "string"
                ? result.error
                : "Could not update the selected CVs.",
          });
      } catch {
        done({
          ok: false,
          error:
            "Could not confirm the update. Reload the CV list before trying again.",
        });
      } finally {
        clearTimeout(timeout);
        inFlight.current = false;
        setPending(false);
      }
    })();
  }
  return (
    <ManagementContext.Provider value={{ pending, pages, run }}>
      {children}
    </ManagementContext.Provider>
  );
}

export function CvPagination({
  archived = false,
  ...props
}: Parameters<typeof Pagination>[0] & { archived?: boolean }) {
  const management = useContext(ManagementContext);
  const current = management?.pages?.[archived ? "archived" : "saved"];
  const other = management?.pages?.[archived ? "saved" : "archived"];
  return (
    <Pagination
      {...props}
      page={current?.page ?? props.page}
      total={current?.total ?? props.total}
      params={{
        ...props.params,
        [archived ? "page" : "archivedPage"]: String(
          other?.page ??
            props.params?.[archived ? "page" : "archivedPage"] ??
            1,
        ),
      }}
    />
  );
}

export function CvSavedTable({
  rows: initialRows,
  archived = false,
}: {
  rows: CvRow[];
  archived?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const management = useContext(ManagementContext);
  if (!management) throw new Error("CV tables must be inside CvManagement");
  const { pending } = management;
  const rows =
    management.pages?.[archived ? "archived" : "saved"].rows ?? initialRows;
  const visibleIds = new Set(rows.map((row) => row.id));
  const selectedIds = selected.filter((id) => visibleIds.has(id));
  const selectedSet = new Set(selectedIds);
  const all = rows.length > 0 && selectedIds.length === rows.length;
  const action = archived ? "restore" : "archive";
  const label = archived ? "Restore" : "Archive";
  const run = (operation: Operation, ids: string[]) => {
    setError("");
    management.run(operation, ids, (result) => {
      if (result.ok) setSelected([]);
      else setError(result.error);
    });
  };
  if (!rows.length)
    return (
      <p className="text-14 text-muted">
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
        <span className="mr-auto text-14 text-muted" role="status">
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
        <p role="alert" className="text-14 text-danger">
          {error}
        </p>
      )}
      <div className="overflow-x-auto border border-line-muted">
        <table className="w-full text-left text-14">
          <caption className="sr-only">
            {archived ? "Archived" : "Saved"} CVs
          </caption>
          <thead className="bg-sunken text-12 text-muted">
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
                Version
              </th>
              <th scope="col" className="p-3">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-muted">
            {rows.map((row) => (
              <tr
                key={row.id}
                className={selectedSet.has(row.id) ? "bg-sunken" : ""}
              >
                <td className="p-3">
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.company} · ${row.jobTitle} · ${cvVersionLabel(row.createdAt, row.dailyVersion ?? Math.max(1, row.revision))}`}
                    checked={selectedSet.has(row.id)}
                    onChange={() =>
                      setSelected((previous) => {
                        const visible = previous.filter((id) =>
                          visibleIds.has(id),
                        );
                        return visible.includes(row.id)
                          ? visible.filter((id) => id !== row.id)
                          : [...visible, row.id];
                      })
                    }
                  />
                </td>
                <td className="p-3 align-top font-medium">{row.company}</td>
                <td className="p-3 align-top">
                  <Link
                    prefetch={false}
                    className="underline"
                    href={`/cv/${row.id}`}
                  >
                    {row.jobTitle}
                  </Link>
                  <span className="mt-1 block text-12 capitalize text-muted">
                    {archived ? `Archived · ${row.status}` : row.status}
                  </span>
                </td>
                <td className="whitespace-nowrap p-3 align-top">
                  <time dateTime={new Date(row.createdAt).toISOString()}>
                    {cvVersionLabel(row.createdAt, row.dailyVersion ?? Math.max(1, row.revision))}
                  </time>
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
